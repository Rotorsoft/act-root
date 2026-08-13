# RFC 1442: `shutdown({ graceMs })` — a bounded wait for in-flight drain cycles

- **Status:** draft
- **Issue:** #1442
- **Author:** Rotorsoft
- **Created:** 2026-08-12

## Motivation

`Act.shutdown()` stopped *scheduling* without waiting for, or cancelling, a drain cycle already in flight. `c.stop()` clears the controller's timer; the `run_drain_cycle` promise already awaiting a handler keeps running.

For a reaction handler parked on an `await` — an HTTP call, a database write — when the operator sends SIGTERM during a rolling deploy, that produced three costs. `shutdown()` returned immediately (measured at 0 ms with the handler still parked). The stream stayed leased, so the replacement worker could not claim it until the lease expired — up to `leaseMillis` of dead time per in-flight stream, and 30s is a recommended value for slow lanes. And the completing handler's ack landed after teardown, where a dropped ack is a short return (#1418), so the round of work was discarded and redelivered — unobserved, because `removeAllListeners()` had already run.

The section of the production checklist titled "Graceful shutdown" discussed ordering so that "an in-flight request can still finish its commit" while saying nothing about in-flight *reactions*, which is the case that actually hurts.

## Public surface added

- **Public type** — `ShutdownOptions` (`libs/act/src/types/reaction.ts`), exported through `@rotorsoft/act` and `@rotorsoft/act/types`:

  ```ts
  export type ShutdownOptions = {
    readonly graceMs?: number;
  };
  ```

- **Changed signature** — `Act.shutdown()` gains an optional parameter:

  ```ts
  shutdown(options?: ShutdownOptions): Promise<void>
  ```

  `shutdown` is a method on the `Act` class, not on the `IAct` interface, so the charter's `IAct` surface is untouched.

Semantics: scheduling stops first, then cycles already in flight are awaited up to the budget, then listeners are removed and the notify subscription is torn down. The budget is a ceiling, not a delay. An exhausted budget proceeds anyway. Idempotent, with the first call's budget applying.

The default is derived from the lanes that actually have a cycle in flight — each contributes its configured `leaseMillis`, or the 10s `drain()` fallback if it pinned none, largest wins, capped at `MAX_SHUTDOWN_GRACE_MS` (30s). `graceMs: 0` restores the previous behavior exactly.

## Alternatives considered

- **Do nothing, document it** (the ticket's option 3). The floor, and it ships either way — § 6 of the production checklist now states the semantics and the `graceMs` trade-off table. But leaving the default at "abandon in-flight work" makes every operator pay lease-expiry dead time on every deploy to learn a lesson the framework already knows.
- **Await in-flight work unbounded.** Rejected in the ticket itself, and rightly: one stuck handler hangs the deploy forever, which is worse than what it replaces.
- **Release the leases on the way out** (the ticket's option 2). Attractive — it fixes the operationally painful half without any hang risk. Rejected here because releasing a lease has no `Store` method: it would need new port surface, TCK cases, and implementations across all three adapters, for a benefit that option 1 already delivers whenever the handler finishes inside the budget. It remains the right follow-up *if* the exhausted-budget path proves common in practice, and it composes with this change rather than competing with it.
- **A fixed default (5s, the common HTTP-server value).** Simple to document, but it ignores the operator's own configuration: a slow lane deliberately set to a 30s lease has handlers expected to run that long, and cutting them off at 5s reintroduces the bug for exactly the lane that cares most.
- **Default `0` (opt-in).** No behavior change on upgrade, but the documented "graceful shutdown" stays aspirational and most operators never find the flag.
- **Max across *all* lanes rather than the in-flight ones.** This was the first implementation, and a test caught it: an app with a 3s slow lane and an idle default lane waited 10s, because the idle lane contributed the fallback. Waiting on behalf of a lane with nothing running is indefensible.
- **Cancel the in-flight handler instead of waiting.** There is nothing to cancel — handlers are user promises with no abort protocol, and inventing one (`AbortSignal` threaded into every reaction) is a much larger surface than this problem justifies.

## Stability / charter impact

**Additive** — a new exported type and a new *optional* parameter on an existing method. Every existing `shutdown()` call still compiles.

**Behavior change, deliberately.** `shutdown()` with no arguments can now block where it previously returned immediately, bounded by the derived budget. This is the point of the change, it is documented in § 6 with the trade-off table, and `graceMs: 0` is a one-word revert for anyone who wants the old semantics. Operators should confirm their orchestrator's termination grace period exceeds the budget — otherwise the process is killed mid-wait and behaves as it did before.

No port method is added, so `Store` / `Cache` / `Logger` and their adapters are untouched, and the TCK is unaffected.

## Open questions

Whether the exhausted-budget path warrants a lifecycle event or a warn-level log, so an operator can see *which* streams were abandoned and tune `graceMs` from evidence rather than guesswork. Left out here to keep the surface minimal; it is the natural companion to option 2 if that lands.
