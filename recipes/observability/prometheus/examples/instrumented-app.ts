/**
 * Runnable: an instrumented Act app producing a real Prometheus scrape.
 *
 *   npx tsx recipes/observability/prometheus/examples/instrumented-app.ts
 *
 * Builds a small app, drives commits and reactions — including one
 * poison stream that blocks — then prints the scrape a Prometheus
 * server would collect from GET /metrics. Everything runs in-process
 * on the in-memory store; the wiring is identical against Postgres.
 */
import { act, dispose, sleep, state } from "@rotorsoft/act";
import { instrument } from "@rotorsoft/act-otel";
import { Registry } from "prom-client";
import { z } from "zod";

const Order = state({ Order: z.object({ placed: z.number() }) })
  .init(() => ({ placed: 0 }))
  .emits({ OrderPlaced: z.object({ sku: z.string() }) })
  .patch({ OrderPlaced: (_, s) => ({ placed: s.placed + 1 }) })
  .on({ place: z.object({ sku: z.string() }) })
  .emit((a) => ["OrderPlaced", a])
  .build();

const app = act()
  .withState(Order)
  .on("OrderPlaced")
  .do(
    async function fulfill(event) {
      // The poison pill: one SKU always fails, so its reaction stream
      // exhausts retries and blocks — watch it land on the gauge.
      if (event.data.sku === "poison") throw new Error("downstream rejects");
    },
    // A short backoff keeps the demo quick; without one, each retry waits
    // the default 10 seconds.
    { backoff: { strategy: "fixed", baseMs: 10 } }
  )
  .to((event) => ({ target: `fulfillment:${event.stream}` }))
  // This demo walks the pipeline itself, so the poison stream's retry
  // budget exhausts deterministically; an app leaves autoSettle on.
  .build({ autoSettle: false });

// The bridge: one call, canonical metric set, on a registry we own.
const registry = new Registry();
dispose(instrument(app, { registry }));

const actor = { id: "ops", name: "Ops" };
await app.do("place", { stream: "order-1", actor }, { sku: "book" });
await app.do("place", { stream: "order-2", actor }, { sku: "lamp" });
await app.do("place", { stream: "order-3", actor }, { sku: "poison" });

// Deterministic processing for the demo: correlate + drain until the
// poison stream exhausts its retry budget (default 3) and blocks. The
// sleep waits out the backoff between attempts.
let blocked = false;
app.on("blocked", () => {
  blocked = true;
});
while (!blocked) {
  await app.correlate();
  await app.drain();
  await sleep(20);
}

// What Prometheus would scrape from your /metrics endpoint:
console.log(await registry.metrics());
await dispose()();
