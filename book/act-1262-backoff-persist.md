# ACT-1262 — when the clever primitive leaked

## The pain that started it

The original backoff design ([ACT-601](act-601-backoff.md)) was proud of what it didn't build. It paced retries without a new store method and without a schema column, by noticing that the drain lease already serialized work across competing workers. Hold the lease instead of releasing it, skip dispatch while a stream sits in its backoff window, and you get free cross-worker pacing. The essay for that ticket called the lease "the cross-worker pacing primitive" and framed the whole thing as a worked example of using the primitives you already have.

It read beautifully. It was also subtly wrong, and the wrongness hid for a long time because every test that touched backoff used a one-millisecond lease.

A scan wave found it. Configure a reaction with `maxRetries: 4` and a fixed backoff, then drain it from a worker whose cycle is faster than the lease, and the stream blocks after three real handler attempts instead of five. The backoff had quietly halved the retry budget. The mechanism was this: the backoff schedule lived only in the worker's in-memory `DeferTimer`, so the store's `claim` had no idea the stream was paused. Once the short lease expired, `claim` handed the stream right back, and `claim` bumps the persisted `retry` counter on every hand-out as a defense against workers that crash mid-attempt. The drain cycle would then look at its local timer, see the stream was still in its window, and skip dispatch. No handler ran, but the retry counter had already climbed. Every idle re-claim during the window spent a retry on nothing.

## Why the obvious answer didn't fit

The instinct is to move the retry increment. If a claim that runs no handler shouldn't cost a retry, then stop counting at claim time and count at finalize time instead, once a real attempt has actually happened. That inverts the bug directly, and it preserves the per-worker pacing model the original essay was so fond of.

It also reopens the hole the claim-time bump was plugging. The counter lives at claim precisely so that a stream which crashes its worker before finalize still accrues toward the block threshold. A poison message that segfaults every worker that touches it has to eventually get quarantined, and the only evidence that it was ever attempted is the claim. Move the increment to finalize and a stream that never reaches finalize never counts, so it crash-loops forever. Trading a budget leak for an unkillable poison stream is not a trade.

A second idea was to keep holding the lease but hold it for the whole window rather than for `leaseMillis`, so the store's own lease exclusion covers the backoff. That keeps the store honest without persisting anything new, but it strands the stream if the holding worker dies. A thirty-second backoff on a worker that crashes one second in leaves the stream locked for twenty-nine seconds with nobody working it. The longer the backoff, the worse the stranding, which is exactly backwards from what you want.

Both alternatives shared a root assumption with the original design, that backoff pacing belongs to the worker. The bug was the evidence that it doesn't. A stream in a backoff window should be paused for everyone, durably, whether or not the worker that paused it is still alive.

## The decision

Act already had a primitive for "hold this stream, revisit it at a specific time, and let any worker honor that." It is the explicit `defer` outcome, and it persists `deferred_at` on the stream through a due-marked `ack`. A backoff retry is just a defer the framework schedules on your behalf, so it now rides the same rail. When a handler fails and backoff is configured, the finalizer acks the lease with `due: nextAttemptAt`, the store writes `deferred_at`, and `claim` skips the stream until the window elapses. No worker re-claims it, so nothing phantom-bumps the counter, and the retry advances exactly once per real attempt.

The one place the two paths diverge is the retry counter itself, and it is worth dwelling on because it is where the store contract had to bend. An explicit defer is not a failure, so it resets retry to `-1`. A backoff retry is a failure being paced, so its counter has to survive the window and keep climbing toward the block threshold. The old due-ack hardcoded the reset, which would have made a persisted backoff immortal: reset to `-1`, claim bumps to `0`, fail, reset to `-1`, forever. So the due-ack contract was refined to persist the lease's own `retry` rather than a hardcoded value. The caller decides. An explicit defer passes `retry: -1` and gets the old reset. A backoff retry passes the climbing counter and gets accrual. One rule, chosen at the call site, instead of a special case buried in the store.

Persisting the schedule made a piece of the drain cycle redundant. The local skip-gate, the `isDeferred` predicate that filtered claimed streams and held their leases, existed only because the store used to be blind to backoff. Now the store is the sole authority on when a stream may be dispatched, so a claimed stream is by definition ready, and filtering it back out would only reintroduce the lease-hold-without-work pattern the fix set out to kill. The gate came out. The in-memory timer stays, but only for what it was always actually good at, waking the drain at the right moment.

The properties fell out of the change rather than being engineered in. Backoff is now the configured delay, honored precisely, because the lease is released at the due-ack and `deferred_at` is the only gate. The cross-worker amplification the original essay defended as a feature is simply gone, since a per-stream schedule can't fire N times for N workers. And the whole thing survives a restart, because the schedule lives in the store.

## What this teaches

The original design's mistake was not the cleverness, it was mistaking a coincidence for a contract. The lease did serialize workers, and for a while that looked like the pacing primitive. But the lease's real job is mutual exclusion for the duration of one attempt, and pacing across attempts is a different concern that only rhymed with it. Overloading the lease worked until the two concerns pulled apart, which they did the moment a worker drained faster than its own lease.

When you find yourself reaching for an existing primitive because adding a new one feels heavy, ask whether the primitive actually models the thing you need or merely resembles it under the tests you happened to write. Act had the right primitive the whole time. It was `deferred_at`, the durable per-stream schedule, and the earlier design walked past it because "don't touch the store contract" was the wrong thing to optimize for. Sometimes the store is exactly where the fact belongs.

## Connections to other chapters

- [ACT-601](act-601-backoff.md) is the design this reverses. Read them as a pair: the first for the appeal of reusing the lease, this one for why the reuse leaked.
- The deferred-reactions work ([ACT-1090](act-1090-deferred-reactions-and-autoclose.md)) is where `deferred_at` and the due-marked ack were introduced. Backoff riding that rail is the payoff for having built it durably.
- The scaling and competing-consumers chapter should retire the "pacing belongs to the worker" framing and replace it with "deferral belongs to the stream, in the store."
