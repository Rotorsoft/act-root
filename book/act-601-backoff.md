# ACT-601 — per-reaction retry backoff

> **Superseded by [ACT-1262](act-1262-backoff-persist.md).** The design below — holding the lease to pace retries, per-worker backoff state, and the `effective_backoff = max(configured, leaseMillis)` floor — was reversed once the "hold the lease" trick was found to leak the retry budget. Backoff now persists `deferred_at` on the stream like an explicit defer. Read this essay for the original reasoning and its appeal; read ACT-1262 for why it didn't hold and what replaced it.

ACT-601 ships per-reaction retry backoff on top of the existing drain pipeline. Material for the error-handling / reactions chapter.

**The gap drain didn't close.** Drain already provided ordered, at-least-once delivery, retries (`maxRetries`), and dead-lettering (`blockOnError` → blocked streams), plus competing-consumer semantics via `SKIP LOCKED`. The one missing primitive: **time between attempts**. A flaky receiver got hammered milliseconds apart, exhausting the retry budget in under a second. Block thresholds fired on what were 200ms transient outages.

Useful framing for the chapter — drain isn't a *delivery system*, it's an *event-fan-out system that happens to provide delivery primitives*. The outbox-pattern reflex (build a parallel subsystem) overstates what's missing. The actual missing piece is one knob.

When the book covers reactions or external integration, lead with what drain already does, then introduce backoff as the one knob it didn't expose. Avoid the trap of motivating backoff with "Act needs an outbox" — that's wrong.

---

**Design without DB or port change.**

- `DrainController` maintains `Map<stream, nextAttemptAt>` in process memory.
- `_finalize` (in `internal/reactions.ts`) computes `nextAttemptAt = now + delay(retry, opts)` and returns it on `HandleResult` for retry-not-block paths.
- After the cycle, the controller stores those into the map.
- On the *next* drain cycle, `runDrainCycle` accepts an `isDeferred(stream)` predicate from the controller. For streams currently in their backoff window, it **claims the lease but skips dispatch** — no handle, no ack, no block. The lease holds for `leaseMillis` via the existing claim mechanism, preventing competing workers from re-attempting during the window.
- A `setTimeout` re-arms drain at the earliest pending `nextAttemptAt`.
- On successful ack or block, the entry clears.

The teachable insight: the **lease itself is the cross-worker pacing primitive**. By holding rather than releasing it, we get free serialization without touching the store contract.

It's a worked example of "use the primitives you have." The naïve solution would be a new Store method (`release` or `defer`) or a schema column (`next_attempt_at` on the streams table). Both work. Neither is necessary, because `claim` + `leaseMillis` together already do what's needed if you flip the perspective from "release on retry" to "hold and skip on retry."

Use this in the chapter on building on top of an event-sourcing core. Frame it as "before adding to your contract, ask which existing primitive does the work."

---

**The per-worker semantics trade-off.**

Backoff state is per-worker (per `DrainController`). With N competing workers:

- Each worker only paces *its own* re-attempts on streams it has failed.
- The shared `retry_count` on the stream watermark climbs across workers — so `blockOnError` fires up to N× sooner than the configured strategy suggests.

Intentional:
- Transient *per-worker* faults (one bad DNS resolver, one network blip, one container with stale DNS cache) recover faster, because other workers genuinely succeed.
- Genuine poison messages reach the block threshold sooner — system gets the right signal quickly.

It's a worked example of "competing consumers means the right granularity for pacing is the worker, not the stream." The book chapter on scaling should use this alongside the existing `SKIP LOCKED` story.

When the book covers backoff or competing consumers, name the trade-off and frame it as a *feature*, not a limitation. The alternative (cross-worker pacing) would require persisting `next_attempt_at` and synchronizing across workers — pay-for-what-you-don't-use complexity.

---

**The `leaseMillis` floor.**

Because the controller holds the lease during the backoff window, `leaseMillis` becomes an effective *floor* on backoff. Configured 50ms backoff with default 10s `leaseMillis` → effective 10s. Configured 30s backoff with 10s `leaseMillis` → controller re-acquires across multiple lease windows until 30s elapses; effective 30s.

Rule: `effective_backoff = max(configured, leaseMillis)`.

Predictable, never shorter than configured. A nice property to call out — backoff is a *lower bound*, not a target. Operators tune `leaseMillis` if they need tighter floors. Use as a tuning example in the chapter on production deployment.

---

**Connections to other chapters.**

- The integration chapter (#689 ACT-603) should reference backoff as the answer for inline delivery; for high fan-out, forward to a bus.
- The webhook helper (#688 ACT-602 `httpDeliver`) is the obvious caller of backoff — and the place where per-reaction `leaseMillis` may become useful enough to add later.
- The scaling chapter should use the per-worker pacing as a concrete example of competing-consumer semantics done right.
