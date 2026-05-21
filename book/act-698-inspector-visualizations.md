# ACT-698 — Inspector priority + lane visualization

#698 wires the lane/priority data path through the inspector UI: Streams view gains `Pri`, `Lane`, and `Age` columns; Monitor view gains priority + lane filter chips, lane chips on blocked and lease rows, and a recent-mutations audit panel. The `prioritize()` mutation surface ships behind an opt-in env var (`ACT_INSPECTOR_WRITE=1`). Notes for the tooling chapter.

The interesting thread here isn't the UI work — it's what a *visualization* makes operators see that a *log* doesn't. The lane PR (ACT-1103, #733) shipped lane-aware traces months ago; `>> drained writes CalculatorA<-A [#42 DigitPressed] ✓ @43` already tells you which lane ran. So why bother rendering chips and columns?

The answer is in the question. The trace is a stream of events; the inspector is a snapshot of state. They answer different operational questions: "what just happened?" vs. "what's going on right now?" Priority and lane are state attributes — they live on `streams.priority` and `streams.lane`, not on the events themselves. The trace can only echo them as events happen; the snapshot can render the whole landscape at once.

---

### Threads to develop

**1. State vs. event log — the same dichotomy as ES itself.**
Act's whole architecture rests on the distinction between events (what happened) and projections (current state). The inspector mirrors that split: Event Log + Timeline are event projections, Streams + Monitor are state projections. Adding priority/lane to Streams + Monitor is the natural place because those are state attributes; the trace already covers the event side. The book should pull this all the way out: tooling shape follows data shape.

**2. The same hue everywhere.**
The lane work used a violet-183 ANSI code in the drain trace (`C_LANE`). The Streams view column hex-matches that. The Monitor chips and the blocked/lease row pills also match. This isn't decorative — it's a cross-tool affordance. An operator who's seen one lane name in a trace recognizes it instantly when they pivot to the dashboard, without having to re-parse what they're looking at. Color as a name. Worth contrasting against the dashboards where every tool reinvents its palette and operators end up holding a mental color map per tool.

**3. Write mode as a *server-static* gate.**
The first instinct on "should the inspector mutate state?" is "yes, but with a confirmation modal" — the same pattern most admin UIs reach for. We resisted. The flag lives in the server's env, not in browser state, not in a "danger zone" toggle. Reasons in the book:

- A refreshed tab can't reacquire write access. If you accidentally hit Cmd-Shift-R during a high-stakes incident, you don't suddenly have to re-confirm a UI toggle you'd set five minutes ago.
- The decision happens at the *deployment* boundary, where it belongs. Whether this inspector instance is allowed to mutate is an infra question, not a per-session UI question.
- The exception isn't ergonomics in dev (one extra env var); it's safety in prod. The asymmetry is right: pay a small cost in the safe environment, prevent a large one in the dangerous environment.

The pre-existing `backup`/`restore` mutations don't follow this pattern — they predate the gate and rely on a modal confirmation. The book should be honest about that: it's tech debt we noted but didn't fix in the same PR, because the right gate would tighten an existing surface and that scope creep would have hidden the actual #698 work.

**4. The audit log is operational, not compliance.**
In-memory, 100 entries, cleared on restart. The book should be explicit about what that *is* and what it *isn't*. It is: "what did I just do in this dashboard session?" — useful when you've fat-fingered a priority and want to see exactly what filter you committed against. It isn't: "who changed this priority three months ago?" — that requires durable storage, cross-instance correlation, ideally tied to the actor system, and lives one layer up (or one ticket away). Stopping at operational breadcrumbs is the right scope for a dashboard; pretending it's an audit trail would be worse than no audit at all.

**5. The "stale stream" filter is the why for `query_stats({ tail: true })`.**
ACT-639's `tail: true` opt-in returned the earliest event per stream. Without a UI consumer it was a primitive looking for a use case. The Streams view's `Age` column + stale-stream filter is that use case: "show me streams whose first commit was N days ago AND whose last commit was N days ago" — i.e., the long-lived projections that have gone quiet. A common operational pattern that's surprisingly hard to spot without both timestamps on the same row. Worth a callout in the chapter on operational queries.

**6. The chip-as-filter pattern.**
Both the priority counts and lane counts render as chip groups that double as filter controls. Click `p=10 · 3` and the lists below filter to those three streams. This is the UI cousin of the same pattern Act uses for `StreamFilter` in the framework: a description of *which* set of things you're operating on, where the same shape works for "tell me how many" and "show me which ones". The cohesion between the framework primitive and the UI is worth noting — when tooling shape matches framework shape, the operator transfers framework knowledge directly into UI knowledge with no impedance.

**7. The deferred bulk-prioritize modal.**
The original ticket asked for a bulk-update modal with filter fields + preview count + commit. Shipped only the inline single-stream editor in this PR. The reasoning: inline covers the case operators reach for first (one stream's behaving badly, boost it); bulk is rarer and harder to do safely (a regex typo affects many streams). The book should treat this as a recurring shape — ship the path operators land on every day; treat the rare-but-dangerous bulk path as its own design problem. (And note that the lane PR's `StreamFilter.lane` field is already in the mutation's input schema — the bulk surface, when it lands, gets lane scoping for free.)

---

### Pull-quotes

- "Color as a name."
- "The decision happens at the deployment boundary, where it belongs."
- "Stopping at operational breadcrumbs is the right scope for a dashboard."
- "Ship the path operators land on every day; treat the rare-but-dangerous bulk path as its own design problem."
