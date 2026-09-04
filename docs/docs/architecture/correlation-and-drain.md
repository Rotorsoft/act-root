---
id: correlation-and-drain
title: Correlation and drain
---

# Correlation and drain

How reactions actually fire. Two cooperating subsystems with a shared goal: deliver every reactive event to its handler, exactly once, eventually. Different concerns:

- **Correlation** — discovery. Given an event, *which streams* should react to it?
- **Drain** — delivery. Given streams that need processing, *fetch and run* their reactions.

Both run lazily: nothing happens until a caller invokes `correlate()`, `drain()`, `settle()`, or one of the polling timers. The framework never spins up background workers without being told to.

## The shape of a reaction

A reaction is registered against an event name with a *resolver* and a handler:

```ts no-check
.on("OrderPlaced")
  .do(async (event, stream, app) => { /* handler */ })
  .to((event) => ({ target: `order-${event.orderId}` }))   // dynamic resolver
  // or .to("inventory")                                   // static resolver
```

The resolver answers "for this event, which target stream processes the reaction?" Two kinds:

- **Static**: a constant target (string). Known at build time. Subscribed once during `correlate.init()`. Doesn't need event-by-event scanning.
- **Dynamic**: a function `(event) => ({ target, source? })`. Target depends on event content. Discovered lazily by `correlate()`.

:::caution Resolvers must be pure
A dynamic resolver is evaluated **more than once for the same event**: once in `correlate()` to discover and subscribe the target stream, and again in `run_drain_cycle()` to match an event back to the leased stream it belongs to. Those two passes run over separately-fetched event instances and, under competing consumers, often in **different processes** — so the result is never cached or shared between them. A resolver must therefore be a pure function of the event: same event in, same `{ target, source? }` out, with no side effects and no dependence on wall-clock time, external state, or call count. A non-deterministic resolver can subscribe one stream and then match a different one, silently stranding the reaction. Keep resolvers cheap, too — the per-event cost is paid in both phases.
:::

Build-time classification (`internal/build-classify.ts`) walks the registry, partitions resolvers by kind, and stashes:

- `staticTargets[]` — subscribed once at init
- `reactiveEvents: Set<string>` — events with at least one reaction; drives the drain skip-flag in `do()` and `reset()`

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

**Cold-start floor (ACT-1207).** A restart resumes from the durable correlate checkpoint ([#1484](https://github.com/Rotorsoft/act-root/issues/1484)). On a *first* boot there is none, and the checkpoint would naively jump to the store watermark (`max(at)` across every subscribed stream) — which overshoots any event committed but not correlated before a crash, since a busier stream can have acked past it. The cold-start checkpoint is therefore floored at `watermark - back_scan` so the crash-window tail is re-scanned. Re-scanning already-correlated events is harmless: `subscribe` is an idempotent UPSERT and a re-issued mark never regresses.

### The subscribed-streams LRU

`CorrelateCycle` remembers what each target was last subscribed at, in an LRU capped at 1000 entries (configurable via `ActOptions.maxSubscribedStreams`). Apps that mint millions of dynamic targets — e.g., one stream per user activity — would otherwise grow this map unbounded.

It no longer decides *whether* a target is re-subscribed (every marked target is), only *what travels with the mark*. A resolution that beats the recorded priority floor raises priority and lane; one that doesn't re-sends the values the row already holds, because `subscribe` writes lane on every call and the mark has to ride the same upsert. Static targets sit at a `+Infinity` floor, so a dynamic resolution can never re-open what the build-time subscribe owns ([#1363](https://github.com/Rotorsoft/act-root/issues/1363)).

Only **dynamic** targets live in the LRU. A static target's record is held in a plain map alongside it, never evicted — the collection is the build-time list of static targets, already bounded by the registry ([#1582](https://github.com/Rotorsoft/act-root/issues/1582)). Sharing the bounded map made the `+Infinity` floor a matter of luck: evict a static record and the next dynamic resolution to that target saw no record, read that as never-seen, and re-subscribed the target with its own lane — re-laning a stream whose lane the build-time subscribe owns, and starving it wherever `onlyLanes` had provisioned a worker for the declared lane. There is nothing to warn about now, because there is no path left that reaches it.

Eviction cost, for a dynamic target: the next resolution re-sends its own priority and lane instead of the row's. That is harmless because the store merges both — priority keeps the max, and the lane rides that same max ([#1599](https://github.com/Rotorsoft/act-root/issues/1599)), so a resolution that lost the lane cannot take it back by being forgotten. For those the LRU is a memory bound, not a correctness mechanism.

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
                              disarm if no acks / blocks / errors this cycle
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

- `do()` sets `_armed = true` if any committed event is in `reactiveEvents`
- `reset()` sets `_armed = true` if there are any reactive events
- `correlate.init()` sets `_armed = true` on cold start (might have historical reactive events to process)
- `drain()` clears `_armed` in two cases: `claim()` returned no leases (fully caught up), or the cycle finished with no acks, no blocks, no errors

When `_armed` is false, `drain()` returns immediately without issuing `claim`. Three round trips saved per call (`claim`, `query`, `ack`). Cold start: armed by `correlate.init()` so historical events are picked up on first drain.

### One controller per lane

ACT-1103: the orchestrator builds one `DrainController` per active lane (implicit `default` + every `.withLane(...)`). `Act._drainAll` runs every controller's `drain()` in parallel via `Promise.all` and aggregates `fetched`/`leased`/`acked`/`blocked`. Each controller filters its `claim()` by its lane — durable adapters serve the filter from `streams_lane_ix` so the four parallel claims add up to the same total work the single all-lanes claim was doing.

The `_armed` flag is per-controller. `do()`, `reset()`, `unblock()`, and the cold-start path arm every controller via `Act._armAll`. Per-lane `LaneConfig.cycleMs` auto-starts a `setTimeout` chain on the controller that drains at the lane's cadence independent of the Act-level settle loop — useful for "always-on" lanes that need low commit-to-ack latency without callers explicitly driving `settle()`. Apps that never call `.withLane(...)` see one controller with `lane: undefined`, and the adapter SQL collapses to the pre-1103 shape. See [Concepts → Lanes](../concepts/configuration.md#lanes).

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
                                                               acked.length > 0 ||
                                                               blocked.length > 0
                                                              │
                                                              ▼
                                                  emit "settled" with last drain
```

"Until no progress" handles paginated catch-up. After `app.reset(...)`, a settled stream might have thousands of events. One drain cycle's `streamLimit × eventLimit` won't catch up; subsequent cycles will. `settle()` doesn't return until the work is done — the caller gets the `"settled"` event when there's nothing left.

The debounce is `ActOptions.settleDebounceMs ?? 10` by default. Coalesces commits in the same tick (typical pattern: tRPC mutation chain calling `app.do` many times) into one settle pass.

**Mid-cycle wake-ups are never dropped (ACT-1205).** The reentrancy guard skips starting a second overlapping cycle, but a `schedule()` whose timer fires *while a cycle is running* is recorded as pending rather than discarded — the running cycle's `finally` re-arms it. Without this, a commit landing during the final no-progress drain pass (its wake-up firing just before `_running` clears) would be lost, and armed controllers could starve on an instance with no lane `cycleMs` and no polling.

## Why drain is one-cycle, settle is the loop

`drain()` is one round-trip: claim, fetch, dispatch, ack/block, return. Predictable. Useful for tests and synchronous catch-up scripts where the caller wants control over each cycle.

`settle()` wraps drain in a debounced async loop with progress detection. Useful for production: fire and forget; the framework figures out when "done" means done. Listeners on `"settled"` get notified once per coalesced burst.

Mixing them is fine — `settle()` doesn't acquire any global lock, just a per-controller reentrancy guard. Multiple settle calls on different Act instances proceed independently.

## Pointers

- `libs/act/src/internal/correlate-cycle.ts` — `CorrelateCycle` class, init, scan, polling
- `libs/act/src/internal/drain-cycle.ts` — `runDrainCycle` (pure cycle), `DrainController` (stateful driver)
- `libs/act/src/internal/drain-ratio.ts` — adaptive lag/lead ratio
- `libs/act/src/internal/settle.ts` — `SettleLoop` debounce + progress loop
- `libs/act/src/internal/build-classify.ts` — registry classification at construction
- `libs/act/src/builders/reaction-builder.ts` — `build_handle` / `build_handle_batch` — what runs inside a drain cycle for each leased stream
