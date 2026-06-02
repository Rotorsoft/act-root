# ACT-1111 — per-action retry policy for ConcurrencyError

ACT-1111 closes the gap between Act's two retry paths: reactions already declared their retry budget on the slice (`.do(handler, { maxRetries, backoff })`), but commands made callers wrap every `app.do(...)` in a copy-paste loop. Material for the error-handling chapter and a worked example of when to expand the orchestrator's contract instead of shipping a helper.

**The pattern the docs printed.** Until this ticket, the `error-handling.md` page had a literal snippet captioned "Retry Pattern" — a `withRetry(action, target, payload)` loop that caught `ConcurrencyError`, ran a budget, and rethrew on exhaustion. Every Act app handling user-driven commands copied it. The framework was distributing a workaround.

The temptation was to ship the workaround as a helper: extract the snippet into `withRetry(fn, opts)`, export it from the package, point the docs at the import. Half-an-hour ticket. Done.

That's the wrong move, and the *why* is the part worth preserving for the book.

---

**The wrong turn.** Shipping `withRetry(fn, opts)` was the original scope. The argument for it was straightforward — apps already wrote the loop, the helper composes around any async call, no charter expansion. A clean caller-side primitive.

What killed it was the symmetry check. Reactions don't make the caller pace retries; the slice author declares `{ maxRetries, backoff }` once on `.do(handler, options)`, and the orchestrator owns the loop. Commands had no equivalent. Same framework, two different mental models depending on whether the failure happened on the command path or the drain path.

The principle the chapter should lead with: **the author of the unit of work knows its operational profile; the caller shouldn't have to.** A `transfer` action on a hot account stream contends; an `audit_ping` on a low-traffic stream doesn't. The slice author has both pieces of information at the point they declare the action. The caller has neither, and there are typically many callers per action — a tRPC mutation, a worker, a CLI tool, a forwarded-bus consumer.

A caller-side helper forces every call site to remember the right wrapping. A declarative shape on the action means write-once.

---

**The pivot — `state.on(entry, ActionOptions)`.** The shape we landed on:

```ts
state({ HotAccount: z.object({ balance: z.number() }) })
  .init(() => ({ balance: 0 }))
  .emits({ Transferred: z.object({ amount: z.number() }) })
  .on(
    { transfer: z.object({ amount: z.number() }) },
    { maxRetries: 5, backoff: { strategy: "exponential", baseMs: 10, maxMs: 200, jitter: true } },
  )
    .emit((a) => ["Transferred", { amount: a.amount }])
  .build();
```

Backward-compatible: `state.on(entry)` keeps current behavior (`ConcurrencyError` surfaces on first conflict). Adding the second arg opts into orchestrator-owned retry. No call-site change.

The orchestrator wires the loop in `event-sourcing.action()`. On `ConcurrencyError` it invalidates the cache (existing behavior), applies optional backoff, and re-runs from `load()` — which now reads fresh state because the cache invalidation forces a store round-trip. Non-`ConcurrencyError` rethrows immediately; the budget exists for one specific failure mode and nothing else.

Reactions don't pay the cost. Reaction-driven actions pass `undefined` as `expectedVersion` to `Store.commit` (stream leasing already serializes them), so `ConcurrencyError` is structurally unreachable on that path. The retry loop is a free no-op for reactions.

The chapter framing: the orchestrator absorbs the conflict; the caller is unchanged. Compare to the reaction side — same shape, same author-owns-policy principle, isomorphic mental model.

---

**The backoff rethink.** First pass of the design wrote off backoff entirely. Argument: optimistic-concurrency conflicts resolve faster with immediate retry. Bare `continue`, no delay. The original `withRetry` snippet in the docs does exactly this.

Wrong, or at least overconfident. The honest picture is:

- **Low contention** — two or three writers racing. Immediate retry is fine; each round eliminates one, latency stays bounded.
- **High contention** — N writers all loaded at v10, racing. They lose in lockstep, retry instantly, re-race, lose again. CPU/DB load grows quadratically with N, the "winner" of each round is whichever writer reconnects fastest (no fairness), and late-bound writers see linear-in-position latency.

The canonical OCC literature (Postgres-flavored or otherwise) is unanimous: jittered exponential backoff is the textbook pattern. Pretending it doesn't apply because Act's `ConcurrencyError` "isn't really transient" was sleight of hand — under contention, the conflict *is* the transient condition, and pacing it works.

So `ActionOptions.backoff` reuses the existing `BackoffOptions` shape from the reaction side. Default omitted (immediate retry, fine at low contention); declared on hot actions where the author knows the contention profile demands pacing. Same `computeBackoffDelay(attempt, opts)` helper drives both paths — the math doesn't care whether the failure came from the command commit or the reaction handler.

The teachable framing: defaults should match the common case (low contention, immediate retry); options should make the uncommon case (hot stream, jittered exponential) expressible without escape-hatching out of the framework.

---

**The `BackoffOptions` move.** Smaller design call but worth recording. `BackoffOptions` and `BackoffStrategy` lived in `types/reaction.ts` because reactions were the first consumer. With actions adopting them, two options surfaced:

1. **New `types/backoff.ts` file** — topic-per-file, matches the existing `internal/backoff.ts` symmetry.
2. **Move to `types/action.ts`** — `action.ts` has organically become the kitchen-sink for primitives that span layers (`Schema`, `Actor`, `Committed`, `Snapshot`, `IAct`, `Query`, `EventMeta`, `State` — none of which are action-specific).

We picked (2), against the topic-per-file instinct. The reasoning the chapter should preserve: the kitchen-sink pattern was already the precedent. Either fix it everywhere (extract a `types/primitives.ts`, move a dozen types, churn every import) or stop pretending the file name describes its contents. The minor refactor wasn't worth the diff in a per-action-retry ticket; the major refactor is a separate decision.

So `BackoffOptions` joined the kitchen-sink. `reaction.ts` cross-imports it. `internal/backoff.ts` retargets its import. No public-surface change — the type still imports from `@rotorsoft/act` for users.

When the book covers the type taxonomy, this is the case study for "the cheap wrong fix would have been a third option."

---

**The escape hatch we kept.** The docs page still shows a manual `withRetry` loop, but as a footnote: *use this when you need different behavior than what's declared on the action*. Concrete example — a UI mutation that should fail fast and surface the conflict to the user, even when the action declares `maxRetries: 5` for worker callers.

The principle: declarative defaults should cover the common case; manual wrapping stays available for the calls that genuinely need different policy. Don't ship a primary mechanism that has no escape.

---

**Connections to other chapters.**

- The reactions chapter (ACT-601 backoff) is the parallel half. The book should pair them — actions and reactions both use orchestrator-owned retry loops with the same `BackoffOptions` shape; the only differences are who declares (state author vs. slice author) and where the loop lives (`event-sourcing.action()` vs. `DrainController`).
- The concurrency-model chapter (`docs/docs/architecture/concurrency-model.md`) talks about optimistic concurrency as the user-facing failure mode; this ticket makes the standard remedy declarative. Update the "Resolution" paragraph to point at `ActionOptions` instead of the manual loop.
- The Phase 1.1 tracker (#748) noted that #740 (`settleOnCommit` / `logBlocked`) and #741 (`replayUntilSettled`) face the same declarative-vs-helper question. The deferred decision is recorded as comments on those tickets; the principle established here ("orchestrator owns the policy when it has enough information") is the criterion for the call.
