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
   * Retiring a stream deletes its events, seeds a tombstone or snapshot, and
   * forgets its subscription. The first two are event-log work; the third is
   * subscription work. Before
   * [#1527](https://github.com/Rotorsoft/act-root/issues/1527) `truncate` had
   * to do all three atomically, which a hybrid cannot — so this file was the
   * one place a hybrid owed real work rather than delegation, and it had to
   * reason about crash windows across two systems.
   *
   * Now `truncate` is the event-log half alone, and `retire` below is the
   * subscription half. `Act.close` sequences them.
   */
  truncate: log.truncate.bind(log),

  /**
   * The subscription half of retirement.
   *
   * `Act.close` calls this **after** a successful truncate, with only the
   * streams it seeded with a tombstone — a stream seeded with a snapshot was
   * restarted, is still consuming, and keeps its subscription.
   *
   * The ordering argument that used to live here now lives in the
   * orchestrator, so every hybrid inherits it instead of re-deriving it: the
   * log goes first because its truncate commits the tombstone that stops new
   * events landing, so a crash between the two steps leaves an orphaned
   * subscription row that claims nothing and is reaped by the next close. The
   * reverse order would leave a live stream with no subscription, which
   * silently stops delivery and never heals.
   */
  retire: subs.retire?.bind(subs),
});
