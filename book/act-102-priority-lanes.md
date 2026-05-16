# ACT-102 — reaction priority lanes

ACT-102 ships per-target priority lanes — `.priority(n)` on the resolver, `app.prioritize(filter, n)` for runtime override, `claim()`'s lagging frontier orders by `priority DESC, at ASC`. Notes for the scaling chapter.

The discussion of priority is *much* more interesting than the feature itself. Most production-grade ES frameworks bolt on FIFO queues without ever questioning the scheduling policy; Act's research-led approach (benchmark first, ship only if numbers say so) is a chapter angle worth taking time on. Comes after dual-frontier in the scaling chapter. Use the saturated-replay scenario as the motivating example — it's the only case where priority binds, and explaining *why* makes readers internalize how the dual-frontier works in the first place.

---

### Threads to develop

**1. The premise of "priority" is suspect in ES.**
Most queue systems offer priority as a feature without justification. In ES, the natural ordering is event id — temporal, deterministic, audit-friendly. Reordering events would break the per-stream ordering invariant, which is foundational. So priority can *only* mean stream-level scheduling priority, not event-level. The book should make that distinction explicit and crisply: "priority biases which streams `claim()` picks first; events within a stream still drain in id order, period."

**2. Saturation is the only place priority matters.**
Frame it operationally: count candidate streams vs. `streamLimit`. If `streamLimit ≥ candidates`, every stream gets a slot every cycle and priority is irrelevant. Priority only binds under contention. Concrete numbers: the default `streamLimit = 10`; you start needing priority when 15+ behind streams compete for slots simultaneously. Cold starts, projection rebuilds after `app.reset(...)`, post-incident catch-up — that's the whole list of scenarios.

**3. Tied watermarks and the underlying tie-break.**
With everyone at `at = -1` (cold replay), the existing `ORDER BY at ASC` collapses to no useful order — PG's physical row order breaks the tie, which is undefined from the framework's perspective. So priority replaces a *random* tie-break with a *deterministic* one. The book should explain that priority isn't accelerating absolute throughput; it's giving operators a deterministic say in *which arbitrary lanes win when the tie-break would otherwise be arbitrary*.

**4. Build-time vs. runtime — two different actors.**
Two different APIs because they're for different actors:
- `.priority(n)` on the resolver: the *developer* expressing "this reaction is structurally more urgent than its peers." Build-time, baked into the registered reactions, subject to `max()` (highest registrant wins). Survives redeploys.
- `app.prioritize(filter, n)`: the *operator* responding to a current operational situation. Runtime, sets the value as-is (can decrease), survives until next subscribe call that bumps it (or gets reset by another prioritize). Doesn't survive a `reset()` that clears priorities.

Different mental models, same underlying column. Worth contrasting because most frameworks have only one or the other.

**5. The `max()` invariant for build-time priority.**
When two reactions target the same stream with different priorities, the highest wins. *Why max?* Because the alternative ("last-registered wins" or "first-registered wins") is brittle to slice ordering. The user shouldn't have to know which slice declares which reaction first. `max()` is the only ordering-invariant reducer that gives consistent behavior. Discuss this contrast: it's a small design call but it shows up in surprising places (priority lanes, slice composition, reaction merging).

**6. Don't mistake priority for a queue feature.**
This is where priority systems usually go wrong: people think "high-priority reaction → run sooner" but they forget that priority operates at the *stream level*, not the *reaction level*. Sample miscondition: "I want my email reaction to fire before my audit reaction on the same OrderConfirmed event." That's only achievable if email and audit are on **different target streams**, in which case they already drain in parallel and priority isn't relevant. If they're on the same target stream, no priority value reorders them.

This is a teachable misconception — show how Act's design forces the user to set up two target streams (or one with FIFO order), and how priority then schedules between those two streams.

**7. Benchmark-led engineering — the meta-lesson.**
Before shipping ACT-102, the change went through a benchmark-only branch that measured the proposed feature against the existing dual-frontier. Findings: ~11× speedup on the priority target, ~6 % faster total drain, zero starvation cost. The decision to ship was data-driven; if numbers had been ambiguous (say, 1.5× with 10 % starvation cost), the feature would have been deferred to 1.1.

Lesson for the book: framework features should earn their inclusion through measurement, not intuition. Most frameworks accumulate features whose marginal value is unmeasured. Act's approach — research-branch first, decide go/no-go, then implement — is worth highlighting as a development practice.

**8. Operational scenarios for `app.prioritize`.**
Concrete examples to make the runtime API land:
- "We released a bug in the projector for `proj-orders`; all customers are complaining. We `app.reset(['proj-orders'])` and `app.prioritize({stream: 'proj-orders', stream_exact: true}, 100)` so that replay finishes in minutes instead of being stuck behind unrelated catch-up streams."
- "Our audit pipeline is slow today — we're running close to capacity. `app.prioritize({source: '^audit-'}, -5)` deprioritizes audit streams until the situation passes."
- "Migration weekend: we're rebuilding ten projections from scratch. We boost the customer-facing one to `100`, leave background ones at `0`, and let the dual-frontier sort it out."

---

**Connections:**
- `advanced-features.md` — settle, drain, dual-frontier (priority extends these).
- `act-101-cross-process.md` — saturation scenarios overlap with horizontal scale-out.
- Risk-game examples: tournament-server with priority lane for the active game vs. background analytics replays.
