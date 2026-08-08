# RFC 1405: a pii sidecar for snapshots, and where gating happens

- **Status:** **declined** — status quo kept (option C). This RFC stands as the decision record.
- **Issue:** #1405 (filed out of #1397)
- **Author:** Rotorsoft
- **Created:** 2026-08-08

## Motivation

Two capabilities are closed off for any state whose events carry `sensitive()` fields:

- `.snap(...)` is rejected at build time (`act-builder.ts:667-674`).
- `close({ restart: true })` is refused and lands the stream in `skipped` (`close-cycle.ts:141-165`, #1397).

So a sensitive-bearing aggregate can only grow, or be retired entirely. For a customer, a patient record, a subscriber — the shapes most likely to be long-lived and most likely to carry PII — that is exactly backwards.

## The blocker is not the sidecar

The issue sketches the fix as "give the snapshot event the same pii split every domain event has." That is necessary and it is the easy half. The hard half is that **there is no plaintext state to split.**

For a pii-aware state the derived state is *actor-dependent*. The fold applies the gate per event, before reduction:

```ts
// event-sourcing.ts:494
event = me.view(raw, actor);            // [REDACTED] / [SHREDDED] / plaintext
if (event.name === SNAP_EVENT) state = event.data;
else if (me.patch[event.name])
  state = patch_fn(me, state, me.patch[event.name](event, state), event);
```

This is deliberate and documented — `sensitive-data.md`: *"the reducer chain runs against the actor-gated view, so derived `state` reflects only what the calling actor is allowed to see… The strictness is deliberate."* It is also why the snapshot **cache** is disabled for these states (#861): state varies by caller, so there is no safe cache key.

A snapshot is a shared, actor-independent artifact. Under the current fold, the state reaching `snap()` is whatever the *writing* actor was allowed to see. Seed it actorless and you persist `[REDACTED]` while deleting the originals; seed it privileged and you persist plaintext into a payload `forget_pii` cannot reach. Both refusals are correct given that fold. **The question this RFC has to answer is not "what does the snapshot row look like" — it is "where does gating happen."**

## What is settled

The storage layout, either way: the snapshot event gets the same `data` + `pii` split as any domain event, keyed on fields marked `sensitive()` on the **state schema** (`pii_fields(state.state_schema)`), not on the event schemas. State field names need not match event field names, and the state schema is the only place that can say which *state* fields are sensitive. `sensitive()` is already public and already usable in a state schema — it is currently ignored there.

With that layout, `forget_pii` reaches a snapshot exactly as it reaches any other event, and a shredded snapshot folds to `[SHREDDED]` for those fields.

## Options

### A. Gate the state, not the events

The fold reduces from the **plaintext** view; `load()` gates the resulting *state* using the state schema's sensitive fields. Gating moves from per-event-before-reduction to per-state-after-reduction.

- Internal state becomes actor-independent, so it is snapshot-able. `.snap()` and `close({restart:true})` both become legal, and the restart seed needs no privileged actor — the load was never what needed authorizing, the *return* is.
- Cold start folds `__snapshot__`, merges its `pii`, continues in plaintext, gates once at the boundary.
- **Cost: a reducer that derives a non-sensitive field from a sensitive one now derives it from plaintext.** `domain = email.split("@")[1]` today yields garbage computed from `"[REDACTED]"`; under A it yields the true domain and returns it to an unauthorized reader. That is a leak through a derived field, and it is a silent one.
  Mitigation is a documented contract — mark every field that carries *or derives from* sensitive data as `sensitive()` on the state schema — plus a build-time error when a pii-aware state declares `.snap()` with no sensitive fields on its state schema, so the opt-in is explicit. It remains a footgun where today there is none.
- Reverses a documented, deliberate choice. Behavior change for every existing pii-aware app, on a documented surface.

### B. Keep the fold gated; privileged re-fold for snapshot writes only

`.snap()` on a pii-aware state triggers an internal plaintext fold used solely to produce the snapshot row.

- Contained: no change to what any existing read returns.
- Costs an extra full replay per snapshot write, which is part of what snapshots exist to avoid. Rare enough to be arguable.
- **Does not actually escape the leak.** The snapshot is written from a plaintext fold, so derived non-sensitive fields are computed from plaintext and frozen into `data`, where nothing gates them. The same leak as A, now persisted, and reachable on the *read* path of every actor.
- Produces a hybrid: events gated per-event, snapshots gated per-state. Two rules for one state.

### C. Status quo

`.snap()` and `close({restart:true})` stay refused for sensitive-bearing states. Correct and safe. Costs unbounded replay on exactly the aggregates most likely to be long-lived, and leaves `close({restart:true})` documented as an option that silently does not apply to them.

### D. Snapshot only non-sensitive state

Rejected in the issue and here: the fold would still need full history to reconstruct the sensitive part, so the snapshot saves nothing on exactly the states it was added for.

## Decision

**C — status quo.** `.snap()` stays rejected at build time for sensitive-bearing states, and `close({ restart: true })` stays refused for their streams. Both refusals are correct given the fold, and neither A nor B is worth its cost:

- **B is a trap** and should not be revisited. It pays a full extra replay per snapshot write *and* keeps the leak permanently, frozen into a row the read path never gates.
- **A is a different framework.** It buys snapshots and restart for these states by reversing a deliberate, documented rule — the reducer chain sees plaintext instead of the gated view — and it converts a currently-impossible leak into a documented-contract one. That is a large behavior change for existing pii-aware apps to unlock an optimization on a minority of states.

The accepted consequence: a long-lived PII-bearing aggregate replays its full history on a cold read, with no snapshot and no cache (#861). If that becomes a real bottleneck for a real app, the lever is a shorter-lived stream design — not a snapshot. Reopen this RFC only with that app's numbers in hand.

Documented in `sensitive-data.md` (both the build error and the restart refusal, with the structural reason), `close-policies.md`, and the close-the-books recipe, so `close({restart:true})` is no longer described as an option that silently does not apply.

## Rejected recommendation (for the record)

**A, or C.** Not B — it pays a full replay per snapshot *and* keeps the leak, permanently, in a row the reader path never gates.

Between A and C the question is whether the framework wants gating to mean "the reducer cannot see it" (today) or "the caller cannot see it" (A). A is the more conventional design and the one that makes snapshots, restart, and eventually the cache work. It is also strictly more dangerous for an app whose reducers derive from sensitive fields, and it changes documented behavior for existing users.

If A: it needs the build-time opt-in, a migration note, and `sensitive-data.md` rewritten around state-level marking.

## Public surface

Under the decision: **none.** Nothing is added, lifted, or changed. The items below described what A or B would have cost.

- No new exports. `sensitive()` gains meaning in a new position (state schemas).
- Two documented errors are lifted (`.snap()` build error, restart refusal) — behavior changes on a documented surface.
- Under A, `load()`/`do()` return values change for unauthorized actors on pii-aware states.

## Open questions

- Does the cache stay disabled under A? State becomes actor-independent, so it *could* be re-enabled — but a Cache adapter is somewhere `forget_pii` cannot reach, so caching plaintext PII opens an erasure hole. Recommend keeping it disabled and treating #861 as unaffected.
- `with_snaps` resume landing on a forgotten snapshot must degrade to `[SHREDDED]`, not resurrect or crash — a TCK case either way.
- Adapters already persist `pii` per event, but `truncate`'s seed-write path and `forget_pii`'s scan must both include the snapshot row.
