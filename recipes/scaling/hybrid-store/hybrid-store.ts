/**
 * A hybrid `Store`: the event log on one system, the subscriptions on another.
 *
 * Callers see one `Store`. Underneath, every method belongs to exactly one
 * half — which is only true since [#1488](https://github.com/Rotorsoft/act-root/issues/1488)
 * removed `claim`'s probe of the event log. Before that, the hottest call in
 * the framework needed both halves at once and this file could not exist.
 *
 * Run it against two Postgres instances:
 *
 * ```ts
 * import { store } from "@rotorsoft/act";
 * import { PostgresStore } from "@rotorsoft/act-pg";
 * import { hybridStore } from "./hybrid-store.js";
 *
 * store(
 *   hybridStore(
 *     new PostgresStore({ port: 5432, schema: "events" }),
 *     new PostgresStore({ port: 5433, schema: "events" })
 *   )
 * );
 * // ...then act()...build() as usual — nothing downstream changes.
 * ```
 *
 * Call `store(...)` BEFORE `act()...build()`: the orchestrator wires its
 * `notify` subscription at construction, so late injection silently does
 * nothing.
 */
import type { Store } from "@rotorsoft/act/types";

/**
 * Compose two stores into one.
 *
 * @param log - holds events: `commit`, `query`, `query_stats`, `restore`,
 *   `forget_pii`, `notify`. Append-only, large, cold.
 * @param subs - holds subscriptions: `subscribe`, `claim`, `ack`, `block`,
 *   `unblock`, `defer`, `prioritize`, `reset`, `query_streams`. Small, hot,
 *   mutated in place.
 */
export const hybridStore = (log: Store, subs: Store): Store => ({
  // ---------------------------------------------------------------------
  // Event log
  // ---------------------------------------------------------------------
  commit: log.commit.bind(log),
  query: log.query.bind(log),
  query_stats: log.query_stats.bind(log),
  ...(log.restore ? { restore: log.restore.bind(log) } : {}),
  ...(log.forget_pii ? { forget_pii: log.forget_pii.bind(log) } : {}),
  // `notify` is a wake-up hint about *commits*, so it belongs with the log.
  ...(log.notify ? { notify: log.notify.bind(log) } : {}),

  // ---------------------------------------------------------------------
  // Subscriptions
  //
  // `at` and `correlated_at` are event-log ids living in the subscription
  // store, which is only safe because nothing here ever dereferences one —
  // they are compared, never looked up. That opaque-token property is what
  // lets the two halves sit on different servers.
  // ---------------------------------------------------------------------
  subscribe: subs.subscribe.bind(subs),
  claim: subs.claim.bind(subs),
  ack: subs.ack.bind(subs),
  block: subs.block.bind(subs),
  unblock: subs.unblock.bind(subs),
  defer: subs.defer.bind(subs),
  prioritize: subs.prioritize.bind(subs),
  reset: subs.reset.bind(subs),
  query_streams: subs.query_streams.bind(subs),

  // ---------------------------------------------------------------------
  // Both halves
  // ---------------------------------------------------------------------
  seed: async () => {
    await log.seed();
    await subs.seed();
  },
  drop: async () => {
    await log.drop();
    await subs.drop();
  },
  dispose: async () => {
    await log.dispose();
    await subs.dispose();
  },

  /**
   * Purely event-log work, so it delegates like everything else.
   *
   * This was the one method that used to span both stores. `truncate`
   * retired a stream by deleting its events, seeding a tombstone, *and*
   * removing its subscription row — three things the port required to be
   * atomic, which is impossible across two systems. Every hybrid had to call
   * the halves in sequence, pick an order, and accept a crash window, and the
   * wrong order failed silently.
   *
   * [#1527](https://github.com/Rotorsoft/act-root/issues/1527) removed the
   * subscription step from `truncate` entirely rather than sequencing it. A
   * retired stream's subscription is inert — the framework refuses commits on
   * a tombstoned stream, so nothing can raise its work mark and `claim` never
   * returns it — so the row can simply stay, keeping the consumer's final
   * watermark as a record of how far it got. Operators reclaim the space on
   * their own schedule if they want it.
   *
   * With that step gone there is nothing left for a hybrid to coordinate.
   */
  truncate: log.truncate.bind(log),
});
