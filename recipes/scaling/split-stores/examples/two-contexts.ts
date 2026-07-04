/**
 * Split stores — two bounded contexts, one process, zero cross-talk.
 *
 * The orders context and the audit context each get their own Act, built
 * with `ActOptions.scoped` ports: one store + one cache per context, always
 * together (a shared cache across distinct stores would collide on stream
 * keys). The framework threads the bag via AsyncLocalStorage, so the domain
 * code stays singleton-style — internal `store()` / `cache()` calls resolve
 * to the right adapter on every call, including inside reaction handlers.
 *
 * The forwarding reaction demonstrates the single-process transitional form
 * of a cross-context reaction: `auditApp.do(...)` called from inside an
 * orders reaction commits to the *audit* store, because the callee's own
 * ALS wrap binds the commit. Once the contexts run in separate processes,
 * that call becomes a bus publish or a POST to an inbound receiver — see
 * docs/docs/guides/external-integration.md — and the receiving side owns
 * idempotency. The reaction shape on the publishing side stays the same.
 *
 * This file uses InMemory adapters so it runs with zero infrastructure.
 * The production shape swaps each store for a per-schema PostgresStore:
 *
 *   scoped: {
 *     store: new PostgresStore({ schema: "orders" }),
 *     cache: new InMemoryCache({ maxSize: 5000 }),
 *   }
 *
 * Run:  pnpm tsx recipes/scaling/split-stores/examples/two-contexts.ts
 */

import {
  act,
  InMemoryCache,
  InMemoryStore,
  state,
  store,
} from "@rotorsoft/act";
import { z } from "zod";

const actor = { id: "ops", name: "split-stores-demo" };

/** The "orders" bounded context — lives in its own store. */
const Order = state({
  Order: z.object({ placed: z.boolean(), sku: z.string() }),
})
  .init(() => ({ placed: false, sku: "" }))
  .emits({ OrderPlaced: z.object({ sku: z.string() }) })
  .patch({ OrderPlaced: (e) => ({ placed: true, sku: e.data.sku }) })
  .on({ placeOrder: z.object({ sku: z.string() }) })
  .emit((a) => ["OrderPlaced", a])
  .build();

/** The "audit" bounded context — separate store, separate cache. */
const Audit = state({ Audit: z.object({ entries: z.number() }) })
  .init(() => ({ entries: 0 }))
  .emits({ Recorded: z.object({ what: z.string() }) })
  .patch({ Recorded: (_e, s) => ({ entries: s.entries + 1 }) })
  .on({ record: z.object({ what: z.string() }) })
  .emit((a) => ["Recorded", a])
  .build();

// One pair of ports per context. Scoped adapters are NOT registered with
// the framework's dispose() registry — the operator owns their lifecycle.
const ordersStore = new InMemoryStore();
const auditStore = new InMemoryStore();

const auditApp = act()
  .withState(Audit)
  .build({
    scoped: { store: auditStore, cache: new InMemoryCache() },
  });

const ordersApp = act()
  .withState(Order)
  .on("OrderPlaced")
  .do(async function forwardToAudit(event) {
    // Cross-context boundary: an originating commit in the audit store.
    // Correlation chains stop here — carry the upstream correlation id in
    // the payload if traces must stitch across stores.
    await auditApp.do(
      "record",
      { stream: `audit-${event.stream}`, actor },
      { what: `${event.name}@${event.stream}` }
    );
  })
  .to(() => ({ target: "orders-to-audit" }))
  .build({
    scoped: { store: ordersStore, cache: new InMemoryCache() },
  });

async function main() {
  await ordersApp.do(
    "placeOrder",
    { stream: "order-1", actor },
    { sku: "sku-42" }
  );
  await ordersApp.correlate();
  await ordersApp.drain();

  // The audit context saw the fact...
  const audit = await auditApp.load("Audit", "audit-order-1");
  console.log("audit entries:", audit.state.entries); // 1

  // ...and neither store holds the other context's streams.
  const leaks: string[] = [];
  await ordersStore.query(
    (e) => {
      leaks.push(e.stream);
    },
    { stream: "audit-order-1", stream_exact: true }
  );
  await auditStore.query(
    (e) => {
      leaks.push(e.stream);
    },
    { stream: "order-1", stream_exact: true }
  );
  console.log("cross-store leaks:", leaks.length); // 0

  // The process-wide singleton store never saw a single event either.
  let singleton = 0;
  await store().query(() => {
    singleton++;
  });
  console.log("singleton store events:", singleton); // 0

  // Shutdown order: quiesce each Act, then dispose its ports — the
  // framework only disposes singletons, never scoped adapters.
  await ordersApp.shutdown();
  await auditApp.shutdown();
  await ordersStore.dispose();
  await auditStore.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
