# ACT-1296 — the block that a successful sibling erased

The drain cycle finalizes a batch of reactions in two store calls: `ack` advances each stream's watermark past the events it handled, and `block` marks the poison streams so no worker claims them again. For most cycles the two touch disjoint sets — a stream either made progress or it failed — so the order between them never mattered. Nobody thought about the order because nothing forced them to.

The case that forces them to is partial progress. A reaction fetches two events for one stream in a single cycle, succeeds on the first, and throws `NonRetryableError` on the second. That finalizes with `handled > 0` *and* `block: true`: the stream both advanced (past the first event) and needs to block (on the second). The finalizer's own comment promised this lands "in both `acked` and `blocked` for the same stream — by design." The code did the opposite, and quietly.

Here is the mechanism. Every adapter gates `block` on the stream still being leased — `UPDATE ... WHERE leased_by = $by AND blocked = false`. That is deliberate: only the worker currently holding the lease may block the stream, so a stale worker can't block a stream someone else has moved on from. But `ack` *releases* the lease as part of advancing the watermark — `leased_by = NULL`. And `ack` ran first. So on a partial-progress-then-block stream, `ack` advanced the watermark and dropped the lease, then `block` ran its `WHERE leased_by = $by` against a row that no longer matched, updated zero rows, and returned nothing. The watermark moved; the block vanished.

The failure is not loud. The stream isn't blocked, so the next cycle re-fetches the tail event — the one whose handler already declared itself permanently failed — and runs it again. `NonRetryableError` means "do not retry"; the dropped block turned it into "retry exactly once more, on a one-cycle delay." A webhook that got a 404 because the user was deleted fires a second time. Eventually the block does land (the next cycle has no successful prefix to advance past, so `ack` skips the stream and `block` finds its lease), so the system converges and every suite stayed green over it. It self-healed just well enough to never fail a test.

---

**The wrong turn: teach `block` to re-acquire.**

The first instinct is to make `block` robust to a released lease — drop the `leased_by` predicate, or have the finalizer re-lease before blocking. Both are wrong for the same reason: the `leased_by` guard is load-bearing. It is what stops a worker whose lease expired mid-handler from blocking a stream a *different* worker has since claimed and made progress on. Loosening it to paper over an ordering bug trades a rare one-cycle re-run for a real cross-worker correctness hole. The guard should stay exactly as strict as it is.

The actual fix is to stop releasing the lease before the block needs it. `block` runs first, `ack` second. `block` only sets `blocked`/`error` and never touches the watermark or the lease, so running it first is invisible to every stream that isn't blocking. Then `ack` advances the watermark past the handled prefix and releases the lease, exactly as before. The partial-progress stream now lands in both sets because both operations run against a lease that is still held when each needs it. No predicate loosened, no re-lease invented — just the two calls in the order their preconditions require.

The rule worth keeping: when two finalize steps share a precondition and one of them consumes it, the consumer goes last. The `leased_by` guard was the shared precondition; `ack` consumed it; so `ack` had to move after `block`. The comment claimed the outcome the code couldn't deliver because the ordering silently withdrew the guarantee the guard was there to provide.

See `libs/act/src/internal/drain-cycle.ts` (the finalize block) and [#1296](https://github.com/Rotorsoft/act-root/issues/1296).
