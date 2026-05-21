# ACT-708 — Inspector schema-evolution view

#708 ships the Schema Evolution tab in the inspector: workspace event-name rollup with deprecation status, drill-through modal listing streams that still hold a deprecated event, and a time-travel "as-of" toggle on the stream detail panel. Plus a deliberate non-feature: the inspector doesn't close streams directly. Notes for the tooling chapter.

The thread worth pulling on isn't the UI. It's the question this view exists to answer — "ok, but how big is the legacy backlog?" — and the layered reasoning about *whose* problem that question is, and what the inspector is allowed to do about it.

---

### Threads to develop

**1. The post-migration silence.**
ACT-403's `_v<digits>` rule (#683) ends with a startup advisory: "your registry has deprecated events." It tells you the *shape* of the migration but not its *size*. After the operator ships `TicketOpened_v2`, they want to know: is the deprecated event 1% of the table or 84%? That answer needs a store query, and a store query at app startup is a footgun on large tables — easily 40 seconds on 4M-event stores. So the framework deliberately stops at the advisory. The Inspector is where it picks up: operator-driven, on-demand, cached until the operator says refresh. The book should treat "framework refuses to do the expensive thing automatically; tooling is allowed to" as a recurring pattern. Same shape as `app.close()` (operator-driven, never auto), `app.reset()` (operator-driven, never auto), the inspector's mutation gate. The framework's discipline is to never *surprise* the operator with cost; tooling's job is to make that cost easy to incur when wanted.

**2. The convention is the contract.**
Both the framework and the inspector apply the same `_v<digits>` rule independently — the framework against its in-memory registry at build time, the inspector against event names sitting in PG. They never share state. The shared thing is the *documented convention* in `docs/docs/architecture/event-schema-evolution.md`. The inspector inlines the regex (deliberately doesn't import the framework's `internal/event-versions.ts`) because the convention is the API, and copying the regex is honest about that. If the convention ever changes, both places update. Worth a callout: *the most stable contracts are the ones expressed as documentation about naming rules, not as exported functions*. Once a convention is published, downstream tooling can apply it without taking a dependency on framework internals.

**3. "We surface data; the operator decides."**
The drill-through modal lists streams holding the legacy event but doesn't close them. The original ticket asked for a bulk-close button. We dropped it. The reasoning needs to live in the book because it's a recurring shape: tooling that decides for operators is tooling that hides decisions, and hidden decisions get made wrong under pressure.

The mechanics also matter. `app.close(targets)` orchestrates eight steps (correlate, safety-check, guard, load state, archive, truncate, cache invalidate, emit lifecycle). The orchestration needs the running app's registry and correlator. The inspector has neither — it's a standalone tool pointed at a PG schema. The choice was: (a) call a primitive that *isn't* `app.close()` (raw store tombstone, fewer steps, no archive), (b) RPC into the running app from the inspector (bigger design), or (c) generate a snippet the operator pastes into their own application code. We picked (c).

The book should make the argument explicitly: option (a) violates the framework's safety story — `app.close()` exists *because* raw-tombstone-without-orchestration is the wrong default. Option (b) introduces deployment coupling between tool and target. Option (c) keeps the inspector standalone, the safety boundary intact, and surfaces the data the operator actually needs to make the call themselves. The "Copy app.close()" button is the framework's contract expressed as a clipboard payload — ready-to-paste shape that meets the operator where they are.

**4. Time-travel as forensics, not browsing.**
The "as-of" toggle on the stream detail panel doesn't render an event log frozen at id N. It re-fetches the **stats** — head, tail, name counts — over the prefix `id < N`. The use case is specifically schema-evolution forensics: "what did this stream look like right before we deprecated `TicketOpened`?" The head card answers immediately — if the stream's head at that time was `TicketOpened`, you've found the migration boundary. The book should distinguish *forensic time-travel* (asks a yes/no question about historical state) from *historical browsing* (scrolls through a frozen view). Different UX, different cost model. The inspector ships only the forensic one because that's what the operator actually asks for. The other is a different ticket.

**5. The chip-as-filter pattern, again.**
The drill-through modal renders lane chips in violet, priority chips in amber, and the operator can multi-select streams by lane visually. Same hue convention as the Streams view, the Monitor view, and the drain trace. By the time an operator lands on the schema-evolution drill-through, they've already learned what violet means everywhere else. *Color as a name* — the cross-tool affordance scales: every new view that adopts the convention costs the operator zero new vocabulary. Worth contrasting against dashboards where each pane reinvents its palette and the operator builds a mental color map per tool.

**6. The summary cards are the actionable view.**
Four numbers: total events, deprecated events, distinct names, deprecated names. Together they answer the migration triage question in two glances — "of 5.2M events, 4.2M are deprecated (81%)" tells the operator close-the-books would shrink the working set substantially, which is the whole point of asking. The table beneath is for the follow-up "which event names, which streams". The cards alone could ship as a Slack notification — the table is for the next click. The book should call out that "summary on top, drill on demand" is the right shape for operator dashboards: cheap-to-glance metrics that justify a deeper click, with the deeper click loading on demand rather than rendered eagerly.

---

### Pull-quotes

- "Framework refuses to do the expensive thing automatically; tooling is allowed to."
- "The most stable contracts are the ones expressed as documentation about naming rules, not as exported functions."
- "Tooling that decides for operators is tooling that hides decisions."
- "The 'Copy app.close()' button is the framework's contract expressed as a clipboard payload."
- "Color as a name — every new view that adopts the convention costs the operator zero new vocabulary."
