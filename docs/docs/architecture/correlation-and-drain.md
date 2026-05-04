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

```ts
.on("OrderPlaced")
  .do(async (event, stream, app) => { /* handler */ })
  .to((event) => ({ target: `order-${event.orderId}` }))   // dynamic resolver
  // or .to("inventory")                                   // static resolver
```

The resolver answers "for this event, which target stream processes the reaction?" Two kinds:

- **Static**: a constant target (string). Known at build time. Subscribed once during `correlate.init()`. Doesn't need event-by-event scanning.
- **Dynamic**: a function `(event) => ({ target, source? })`. Target depends on event content. Discovered lazily by `correlate()`.

Build-time classification (`internal/build-classify.ts`) walks the registry, partitions resolvers by kind, and stashes:

- `staticTargets[]` — subscribed once at init
- `hasDynamicResolvers: boolean` — short-circuit flag for `correlate()`
- `reactiveEvents: Set<string>` — events with at least one reaction; drives the drain skip-flag in `do()` and `reset()`

If `hasDynamicResolvers` is false, `correlate()` becomes effectively a no-op past init — no event scan needed.

## Correlation — discovering dynamic targets

`correlate(query)` scans events past the correlation checkpoint, evaluates each registered dynamic resolver, and registers any new (target, source) pairs as subscribed streams via `store.subscribe`.

```
                    correlate({ after, limit })
                              │
                  has dynamic resolvers?
                       no ──┬── yes
                            │     │
                            ▼     ▼
                  return as-is  query events past checkpoint
                                        │
                                        ▼
                              for each event:
                                for each registered dynamic resolver:
                                  resolved = resolver(event)
                                  if resolved.target not yet subscribed:
                                    add to "to subscribe" map
                                        │
                                        ▼
                              subscribe(map.entries())
                                        │
                                        ▼
                              advance checkpoint to last scanned event id
                                        │
                                        ▼
                              add new targets to subscribed-streams LRU
```

The checkpoint advances only after `subscribe` succeeds. If `subscribe` throws, the checkpoint stays where it was and the next correlate retries from the same point.

### The subscribed-streams LRU

`CorrelateCycle` holds an `LruSet<string>` cap (default 1000, configurable via `ActOptions.maxSubscribedStreams`). Apps that mint millions of dynamic targets — e.g., one stream per user activity — would otherwise grow this set unbounded.

Eviction cost: a redundant `store.subscribe` call when an evicted-but-still-active stream's event is correlated again. `subscribe` is idempotent at the store level (`INSERT … ON CONFLICT DO NOTHING`), so this is harmless. The LRU is a memory bound, not a correctness mechanism.

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
                              ops.ack(successes), ops.block(retries-exhausted)
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

```ts
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
- `libs/act/src/internal/reactions.ts` — `buildHandle` / `buildHandleBatch` — what runs inside a drain cycle for each leased stream
