---
id: correlation-and-drain
title: Correlation and drain
---

# Correlation and drain

How reactions actually fire. Two cooperating subsystems with a shared goal: deliver every reactive event to its handler, exactly once, eventually. Different concerns:

- **Correlation** — discovery. Given an event, *which streams* should react to it?
- **Drain** — delivery. Given streams that need processing, *fetch and run* their reactions.

Both run on demand. A local change that frees reaction work (a commit, `reset()`, `unblock()`, `restore()`) schedules `settle()` unless the app sets `autoSettle: false`, and so does a notification from another process; otherwise nothing runs until a caller invokes `correlate()`, `drain()`, `settle()`, or a polling timer.

## The shape of a reaction

A reaction is registered against an event name with a *resolver* and a handler:

```ts no-check
.on("OrderPlaced")
  .do(async function handleOrder(event, stream, app) { /* handler */ })
  .to((event) => ({ target: `order-${event.orderId}` }))   // dynamic resolver
  // or .to("inventory")                                   // static resolver
```

The resolver answers "for this event, which target stream processes the reaction?" Two kinds:

- **Static**: a constant target (string). Known at build time. Subscribed once during `correlate.init()`. Doesn't need event-by-event scanning.
- **Dynamic**: a function `(event) => ({ target, source? })`. Target depends on event content. Discovered lazily by `correlate()`.

:::caution Resolvers must be pure
A dynamic resolver is evaluated **more than once for the same event**: once in `correlate()` to discover and subscribe the target stream, and again in `run_drain_cycle()` to match an event back to the leased stream it belongs to. Those two passes run over separately-fetched event instances and, under competing consumers, often in **different processes** — so the result is never cached or shared between them. A resolver must therefore be a pure function of the event: same event in, same `{ target, source? }` out, with no side effects and no dependence on wall-clock time, external state, or call count. A non-deterministic resolver can subscribe one stream and then match a different one, silently stranding the reaction. Keep resolvers cheap, too — the per-event cost is paid in both phases.

A resolver that throws stops correlation just before that event until it stops throwing (or, during the drain, fails just the stream it was matching); see [Error handling § Store failures only](../concepts/error-handling.md#store-failures-only).
:::

Build-time classification (`internal/classify.ts`) walks the registry, partitions resolvers by kind, and stashes:

- `static_targets[]` — subscribed once at init
- `event_to_lanes` — each event with at least one reaction, mapped to the lanes its reactions run on; `do()` arms only those lanes, and an app whose map is empty never arms a drain (the `_reactive` flag)

## Correlation — discovering targets and marking their work

`correlate(query)` scans events past the correlation checkpoint, resolves each one to its target streams, and records what it found through `store.subscribe`: new dynamic targets get registered, and every target an event resolved to gets its **work mark** raised.

Correlate is the only component entitled to say **which subscribed streams have work**. It is the one that sees every event — whoever wrote it — and can apply a reaction's resolver to it, so it is the one that can record the highest event id resolving to a target: the row's `correlated_at` mark ([#1485](https://github.com/Rotorsoft/act-root/issues/1485)). `claim` then reads eligibility off the subscription row (`at < correlated_at`) rather than re-deriving it from the event log microseconds later.

That is why the scan runs for **every** app since [#1487](https://github.com/Rotorsoft/act-root/issues/1487), not only for apps with dynamic resolvers. A static target is subscribed once at init, but a target correlate never marks is a target `claim` never serves, so statics are resolved event by event too. Two consequences worth knowing:

- **`drain()` alone is not a pipeline.** `claim` consults nothing but the mark since [#1488](https://github.com/Rotorsoft/act-root/issues/1488), so a commit becomes claimable only after the next correlate. Correlate arms the lane controllers whenever it raises a mark, not only when it registers a new target — freshly marked work would otherwise sit until an unrelated commit woke the lane. The supported loops are `settle()` (which is correlate→drain) and the explicit `await app.correlate(); await app.drain();` pair — the one the docs and tests have always used. A bare `drain()` after a commit sees the new work only if a correlate ran in between.
- **A static-only app now pays for a scan it used to skip.** It buys the same O(lease budget) claim every other app gets; on Postgres the measured cost is in [`libs/act-pg/PERFORMANCE.md`](https://github.com/Rotorsoft/act-root/blob/master/libs/act-pg/PERFORMANCE.md).

A mark is an assertion about the log, so the scan only raises one for an event the target's own `fetch` would return — an event outside the subscription's `source` filter is not that target's work and leaves its mark alone.

```
                    correlate({ after, limit })
                              │
                              ▼
                    query events past checkpoint
                              │
                              ▼
                    for each event:
                      for each registered reaction (static AND dynamic):
                        resolved = resolver(event) | resolver
                        raise priority/lane only if it beats the
                          target's last-subscribed floor
                        mark = event.id, if the event is inside the
                          target's source filter
                              │
                              ▼
                    subscribe(targets with a mark or a raise)
                              │
                              ▼
                    advance checkpoint to last scanned event id
                              │
                              ▼
                    record what each raised target was subscribed at
```

The checkpoint advances only after `subscribe` succeeds. If `subscribe` throws, the checkpoint stays where it was and the next correlate retries from the same point.

**Parking the scan ([#1510](https://github.com/Rotorsoft/act-root/issues/1510), [#1517](https://github.com/Rotorsoft/act-root/issues/1517), [#1669](https://github.com/Rotorsoft/act-root/issues/1669)).** Correlate keeps its own armed flag, so a system where nothing has happened stops paying for a scan. A `do()`, `reset`/`unblock`, cross-process `notify`, or poll tick arms it; the scan parks it again only when its page comes back **short**. Resolving no target is not the same proof: every caller passes a `limit`, and most domain events have no reactions, so a full window that resolved nothing is indistinguishable from an empty log — parking there strands every reaction past that window, since the armed check then returns without a store read.

**Cold-start floor (ACT-1207).** A restart resumes from the durable correlate checkpoint ([#1484](https://github.com/Rotorsoft/act-root/issues/1484)). On a *first* boot there is none, and the checkpoint would naively jump to the store watermark (`max(at)` across every subscribed stream) — which overshoots any event committed but not correlated before a crash, since a busier stream can have acked past it. The cold-start checkpoint is therefore floored at `watermark - back_scan` so the crash-window tail is re-scanned. Re-scanning already-correlated events is harmless: `subscribe` is an idempotent UPSERT and a re-issued mark never regresses.

### The correlation lease

On the automatic paths (the settle loop and the poller), one worker scans on behalf of the others, so W workers don't each read and mark every committed event. The lease rides `subscribe` with no streams ("may I scan?") and is renewed at its halfway mark. An explicit `app.correlate()` ignores it and scans now: `close` catches up by looping until the checkpoint moves, and a lease-blocked scan would cap its prune at a stale position.

Leasing is only sound between interchangeable workers. Two processes running the same application are; two applications sharing one database are not, and a shared lease would let one starve the other. So the lease key is a hash of every event name the correlator reacts to, each with the names of its handlers, sorted so declaration order doesn't matter. Event names alone are not enough: two applications can both react to `Placed` and resolve it to different targets. Workers sharded by `onlyLanes` append their lanes to the key, because a holder would mark targets on lanes it cannot drain.

Separate leases do not make two applications over one store supported. They still share one read cursor, so the second would never correlate what the first had already read past. One store belongs to one application (see the split-stores recipe).

### The subscribed-streams LRU

`CorrelateCycle` remembers what each dynamic target was last subscribed at, in an LRU capped at `ActOptions.maxSubscribedStreams` (1000 by default), so apps that mint millions of targets don't grow it without bound. Static targets live in a plain map that never evicts. The record only decides what travels with a target's work mark; the stream's row owns its priority and lane, so a forgotten record is a cache miss, not a lost lane. How a forgotten target keeps its lane is in [configuration § Re-laning at restart](../concepts/configuration.md#re-laning-at-restart).

## Drain — claim, fetch, dispatch

`drain()` runs one cycle of the pipeline:

```
                              drain({ streamLimit, eventLimit, leaseMillis })
                                        │
                              armed? (do() / reset() flagged work)
                                  no ──┬── yes
                                       │
                                  return empty result
                                       │
                                       ▼
                              concurrent drain in flight?
                                  yes ─┬── no
                                       │
                                  return empty result
                                       │
                                       ▼
                              compute lagging/leading split via ratio
                                       │
                                       ▼
                              ops.claim(lagging, leading, by, leaseMillis)
                                       │
                                  ┌────┴───────┐
                                  ▼            ▼
                              empty?       leases
                                │            │
                          disarm; return     │
                                             ▼
                              ops.fetch(leases, eventLimit)
                                             │
                                             ▼
                              for each leased stream:
                                build payloads (filter events to ones
                                whose registered reaction targets us)
                                             │
                                             ▼
                              dispatch via handle / handleBatch
                                             │
                                             ▼
                              ops.block(retries-exhausted) then ops.ack(successes)
                                (block first — ack releases the lease block needs)
                                             │
                                             ▼
                              update lag/lead ratio per pressure
                                             │
                                             ▼
                              emit "acked" / "blocked" lifecycle events
                                             │
                                             ▼
                              disarm only if claim returned nothing
```

### The dual-frontier split

`claim()` takes two budgets: `lagging` (streams with low watermarks) and `leading` (streams with high watermarks). The split is adaptive — `DrainController._ratio` starts at 0.5 and adjusts each cycle based on which frontier produced more events:

```ts no-check
// internal/drain-ratio.ts (paraphrased)
ratio = (laggingHandled - leadingHandled) / total
clamped to [0.2, 0.8]
```

If lagging streams produced more work this cycle, the next cycle leans toward lagging (fast-forward streams that have fallen behind). If leading streams produced more, lean toward leading (keep up with active streams). The clamp prevents starvation in either direction.

### The `_armed` skip flag

A naive drain would query the store on every call. For apps where most actions don't have reactions, that's wasted I/O. The framework keeps an `_armed` boolean on `DrainController`:

- `do()` sets `_armed = true` on the lanes whose reactions match a committed event (`event_to_lanes`)
- `reset()` sets `_armed = true` on every lane when it reset any stream and the app has reactions
- `correlate.init()` sets `_armed = true` on cold start (might have historical reactive events to process)
- `drain()` clears `_armed` only when `claim()` returned no leases. A pass that leased streams is never idle, even if every one of them deferred, backed off or failed: more marked streams may be waiting behind the claim's budget. A pass whose store call fails stays armed and retries after the breaker's `cooldownMs` (never before its leases expire), so an idle app recovers without waiting for the breaker to open

When `_armed` is false, `drain()` returns immediately without issuing `claim`. Three round trips saved per call (`claim`, `query`, `ack`). Cold start: armed by `correlate.init()` so historical events are picked up on first drain.

### One controller per lane

The orchestrator builds one `DrainController` per active lane (implicit `default` + every `.withLane(...)`). `Act._drain_all` runs every controller's `drain()` in parallel via `Promise.all` and aggregates `fetched`/`leased`/`acked`/`blocked`. Each controller filters its `claim()` by its lane — durable adapters serve the filter from `streams_lane_ix` so the four parallel claims add up to the same total work the single all-lanes claim was doing.

The `_armed` flag is per-controller. `do()` and a notification from another process arm only the lanes their events react on; `reset()`, `unblock()`, `restore()`, a `start_correlations` tick and the cold-start path arm every controller via `Act._arm_all`. A lane's `cycleMs` adds a timer that drains it at least that often, which only matters with `autoSettle: false` (see [configuration § `LaneConfig` fields](../concepts/configuration.md#laneconfig-fields)). Apps that never call `.withLane(...)` see one controller with `lane: undefined`, and the adapter SQL collapses to the pre-1103 shape. See [Concepts → Lanes](../concepts/configuration.md#lanes).

## Settle — the catch-up loop

`settle()` is the production-friendly entry point. It debounces multiple rapid calls into one cycle, then runs `correlate → drain` in a loop until a pass produces no progress:

```
                    settle(options) ── debounce timer ── timer fires
                                                              │
                                                              ▼
                                                  reentrancy guard
                                                              │
                                                              ▼
                                                  await correlate.init()
                                                              │
                                                              ▼
                                                  loop until no progress:
                                                    correlate({ after: checkpoint })
                                                    drain(options)
                                                    progress = subscribed > 0 ||
                                                               leased.length > 0 ||
                                                               checkpoint moved
                                                              │
                                                              ▼
                                                  emit "settled" with every pass's drain
```

"Until no progress" handles paginated catch-up. After `app.reset(...)`, a settled stream might have thousands of events. One drain cycle's `streamLimit × eventLimit` won't catch up; subsequent cycles will. A pass that leased streams counts as progress even if every one of them deferred or failed, since more marked streams may wait behind the claim's budget. `settle()` returns at once (it only schedules); the caller hears the `"settled"` event, carrying what every pass acked and blocked, when a pass finds nothing left.

The debounce is `ActOptions.settleDebounceMs ?? 10` by default. Coalesces commits in the same tick (typical pattern: tRPC mutation chain calling `app.do` many times) into one settle pass.

**One scheduling rule.** A pass already scheduled is never put off or replaced. Calls that arrive before it runs join it, so steady commits can't put it off; a shorter `debounceMs` brings it forward, so a long one can't hold back the commits behind it. A call that arrives while a cycle runs queues one more pass after it, so a commit landing during the final no-progress pass is never lost. Only `settle(options)` carries options, and the next pass uses the last caller's; the wake-ups the framework schedules itself (a commit, a reset, an unblock, a restore, a notification, a `start_correlations` tick, the breaker's recovery pass) carry none, so they never discard a caller's `eventLimit` or `maxPasses`.

The cost of that rule: a reaction that commits while the cycle runs queues one more pass, so one chain of reactions can emit `"settled"` twice, the second time for a short pass that finds little or nothing. Listeners on `"settled"` should treat it as "work was done", not "exactly once per burst".

## Why drain is one-cycle, settle is the loop

`drain()` is one round-trip: claim, fetch, dispatch, ack/block, return. Predictable. Useful for tests and synchronous catch-up scripts where the caller wants control over each cycle.

`settle()` wraps drain in a debounced async loop with progress detection. Useful for production: fire and forget; the framework figures out when "done" means done. Listeners on `"settled"` get notified after each cycle, even one that found nothing to do.

Mixing them works, with one catch: each lane's controller runs one drain at a time, so an explicit `drain()` while a settle holds the lane returns empty. Settle's correlate takes the correlation lease, so among workers running the same application over one store one scans on behalf of the others (see [The correlation lease](#the-correlation-lease)); their drains proceed independently.

## Pointers

- `libs/act/src/internal/correlate-cycle.ts` — `CorrelateCycle` class, init, scan, polling
- `libs/act/src/internal/drain-cycle.ts` — `runDrainCycle` (pure cycle), `DrainController` (stateful driver)
- `libs/act/src/internal/drain-ratio.ts` — adaptive lag/lead ratio
- `libs/act/src/internal/settle.ts` — `SettleLoop` debounce + progress loop
- `libs/act/src/internal/classify.ts` — registry classification at construction
- `libs/act/src/internal/reaction-dispatch.ts` — `build_handle` / `build_handle_batch` — what runs inside a drain cycle for each leased stream
