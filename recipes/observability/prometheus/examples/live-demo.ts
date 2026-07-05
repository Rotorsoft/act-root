/**
 * Live: a self-contained instrumented app for the Prometheus UI.
 *
 *   npx tsx recipes/observability/prometheus/examples/live-demo.ts
 *   docker compose -f recipes/observability/prometheus/docker-compose.yml up -d
 *   open "http://localhost:9090/graph?g0.expr=rate(act_events_committed_total[30s])&g0.tab=0&g1.expr=act_streams_blocked&g1.tab=0"
 *
 * Serves /metrics on :4001 and generates its own traffic so every
 * panel moves: orders stream in continuously, a fulfillment reaction
 * (own lane) ships them, a flaky notification reaction (own lane,
 * exponential backoff) fails ~20% of attempts, every tenth order is a
 * poison SKU whose reaction blocks — and an operator loop unblocks the
 * quarantine every 20 seconds, so `act_streams_blocked` saws up and
 * down on the graph. Ctrl-C tears everything down via act's disposal.
 */
import { createServer } from "node:http";
import { act, dispose, projection, state } from "@rotorsoft/act";
import { instrument } from "@rotorsoft/act-otel";
import { register } from "prom-client";
import { z } from "zod";

const Order = state({
  Order: z.object({ sku: z.string(), shipped: z.boolean() }),
})
  .init(() => ({ sku: "", shipped: false }))
  .emits({
    OrderPlaced: z.object({ sku: z.string() }),
    OrderShipped: z.object({}),
  })
  .patch({
    OrderPlaced: (e) => ({ sku: e.data.sku }),
    OrderShipped: () => ({ shipped: true }),
  })
  .on({ place: z.object({ sku: z.string() }) })
  .emit((a) => ["OrderPlaced", a])
  .on({ ship: z.object({}) })
  .emit(() => ["OrderShipped", {}])
  .build();

export const stats = { placed: 0, shipped: 0 };
const OrderStats = projection("order-stats")
  .on({ OrderPlaced: z.object({ sku: z.string() }) })
  .do(async function countPlaced() {
    stats.placed++;
  })
  .on({ OrderShipped: z.object({}) })
  .do(async function countShipped() {
    stats.shipped++;
  })
  .build();

const SYS = { id: "demo", name: "Demo" };

const app = act()
  .withState(Order)
  .withProjection(OrderStats)
  .withLane({ name: "fulfillment", cycleMs: 250 })
  .withLane({ name: "notifications", cycleMs: 250, leaseMillis: 2_000 })
  // Fulfillment: ships every placed order — unless it's the poison SKU,
  // which never succeeds and blocks its stream after the retry budget.
  .on("OrderPlaced")
  .do(async function fulfill(event, _stream, a) {
    if (event.data.sku === "poison") throw new Error("downstream rejects");
    await a.do("ship", { stream: event.stream, actor: SYS }, {});
  })
  .to((e) => ({
    target: `fulfillment:${e.stream}`,
    source: e.stream,
    lane: "fulfillment",
  }))
  // Notifications: flaky on purpose — ~20% of attempts fail, retry with
  // exponential backoff, and eventually succeed. Watch the acked rate on
  // the notifications lane wobble.
  .on("OrderShipped")
  .do(
    async function notify() {
      if (Math.random() < 0.2) throw new Error("smtp hiccup");
    },
    {
      maxRetries: 10,
      backoff: { strategy: "exponential", baseMs: 100, maxMs: 1_000 },
    }
  )
  .to((e) => ({
    target: `notify:${e.stream}`,
    source: e.stream,
    lane: "notifications",
  }))
  .build();
app.on("committed", () => app.settle());
app.on("error", () => {}); // counted by the bridge; keep the console calm

// The bridge — global registry, served below.
dispose(instrument(app));

// Traffic: an order every 300ms, every tenth one poison.
let n = 0;
const traffic = setInterval(() => {
  n++;
  const sku = n % 10 === 0 ? "poison" : `sku-${n % 5}`;
  void app.do("place", { stream: `order-${n}`, actor: SYS }, { sku });
}, 300);
// The operator loop: recover the quarantine every 20s, so the blocked
// gauge saws instead of climbing forever (recovery is app.unblock —
// watermark preserved, no replay).
const recovery = setInterval(() => void app.unblock({ blocked: true }), 20_000);

const server = createServer((req, res) => {
  if (req.url === "/metrics") {
    void register.metrics().then((m) => {
      res.writeHead(200, { "content-type": register.contentType });
      res.end(m);
    });
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(stats));
});
server.listen(4001);

dispose(async () => {
  clearInterval(traffic);
  clearInterval(recovery);
  await new Promise((resolve) => server.close(resolve));
});

console.log(`
live demo on http://localhost:4001  (stats at /, scrape at /metrics)
prometheus UI: http://localhost:9090 after docker compose up — try:
  rate(act_events_committed_total[30s])   commit throughput by event
  act_streams_blocked                     the sawtooth: poison blocks, operator unblocks
  rate(act_reactions_acked_total[30s])    per-lane reaction progress
`);
