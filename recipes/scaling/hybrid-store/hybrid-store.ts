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
   * The one operation that genuinely spans both stores, and the only place a
   * hybrid owes real work rather than delegation.
   *
   * A **windowed** target (`before` set) is a pure prefix delete on the event
   * log and leaves the subscriptions table untouched, so it needs nothing
   * special. A **full** target deletes the stream's events, seeds a tombstone
   * or snapshot, *and* removes the subscription row — two systems, no shared
   * transaction.
   *
   * The trick is that `truncate` is *already* the verb that retires a
   * subscription. Pointing it at the subscription store retires the row there,
   * exactly as it would if both halves shared a database — the same fan-out
   * `seed`, `drop` and `dispose` use above. No second verb is needed.
   *
   * Only genuinely retired targets are forwarded:
   *
   * - **windowed** (`before`) leaves subscriptions alone by contract
   * - **restart** (`snapshot` set) keeps its subscription, because the stream
   *   lives on and a reaction targeting it must keep delivering (#1398)
   * - **skipped** streams are absent from `result` and were never truncated
   *
   * The forwarded targets are stripped down to `{ stream }`, which matters:
   * passing the original target would seed the restart snapshot's *state* into
   * the subscription store, copying domain data — possibly sensitive — into a
   * database that has no business holding it. A bare target seeds a tombstone
   * instead, and its only cost is one inert row in an events table the hybrid
   * never reads.
   *
   * Order matters. The log goes first, because its truncate is the one that
   * commits the tombstone that stops new events landing on the stream. If the
   * process dies between the two, the subscription row is orphaned: it points
   * at a stream whose events are gone, claims nothing (its watermark is at or
   * above the seed), and is removed by the next close of that stream. The
   * reverse order would leave a live stream with no subscription, which
   * silently stops delivery — a worse failure with no self-healing.
   *
   * `Act.close` is already resumable after an interrupted truncate
   * ([#1389](https://github.com/Rotorsoft/act-root/issues/1389)), which is
   * what makes the crash window recoverable rather than merely rare.
   *
   * **Do not reach for `reset` here.** It looks like the subscription-side
   * verb and is the wrong one: it rewinds the watermark to -1 and leaves the
   * work mark alone, so `at < correlated_at` turns true and the retired
   * subscription becomes *claimable again* — the opposite of retiring it.
   */
  truncate: async (targets) => {
    const result = await log.truncate(targets);
    const retired = targets
      .filter(
        (t) =>
          t.before === undefined &&
          t.snapshot === undefined &&
          result.has(t.stream)
      )
      .map((t) => ({ stream: t.stream }));
    if (retired.length) await subs.truncate(retired);
    return result;
  },
});
