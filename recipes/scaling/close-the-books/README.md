# Close the books

The 90% answer to "my events table is growing." You declare a per-state
close policy on the state builder, the framework's autoclose cycle finds
streams whose head event matches, and the events get tombstoned and
truncated in the background. No partitioning, no archival pipeline,
no maintenance window — just a one-line declarator at the call site
of every state whose streams have a definable end of life.

## When to reach for it

Almost always. The symptoms `recipes/scaling/README.md` Gate 1 calls
out — `events` rowcount growing monotonically, projection rebuild
windows growing in lock-step, autovacuum starting to surprise you,
`query_stats` getting slower — all share the same underlying cause.
The events table is full of streams that were semantically complete
months ago but were never told to retire. Close-the-books retires them.

The decision is rarely "should I close" and almost always "what's
my close predicate." Sessions end. Tickets resolve. Orders ship.
GDPR deletion requests have statutory windows. Even apps that
"feel like" they have long-lived streams usually have a terminal
event somewhere — it's just unused. Adding a close policy after
the fact is one of the cheapest operational wins in the framework.

Default Act with no `.autocloses(...)` is also fine. The cycle is
opt-in; absent the declarator the controller doesn't even allocate,
and a happily-bounded fleet pays nothing for the feature. This
recipe is for the workloads that have outgrown default storage.

## The two field shapes

The declarator accepts either a predicate function or a declarative
options object. The function form is the long-tail escape hatch.
The object form covers ~90% of real policies in one line, with
verb-shaped fields (`is`, `after`, `reaches`) that compose at the
call site like a sentence. Full reference lives at
[docs/docs/guides/close-policies.md](../../../docs/docs/guides/close-policies.md);
this page covers the two shapes that show up most.

The canonical wolfdesk Ticket
(`packages/wolfdesk/src/ticket-creation.ts`) declares both shapes
in a single policy:

```ts
.autocloses({
  is: ["TicketClosed", "TicketResolved"],  // terminal events
  after: { days: 90 },                      // cooldown after terminal
  or: { after: { days: 365 } },             // retention-floor backstop
})
```

### Cooldown after terminal (the AND case)

The cooldown-after-terminal pattern runs through almost every
business app: close N days after the terminal event. Top-level
fields combine with AND, so the cycle truncates only when every
condition holds. In wolfdesk's policy that's the `is` + `after`
pair: a ticket that closed or resolved stays queryable for a
90-day return / dispute / customer-success window, then retires
itself. The same shape works for `Delivered` + 14 days on an
order workflow, `Cancelled` + 30 days on a subscription, `Paid`
+ 7 days on an invoice. The runnable example lives at
[examples/ticket-cooldown.ts](examples/ticket-cooldown.ts).

### Retention-floor backstops (the or-block)

A terminal event might never arrive — an abandoned ticket, a
forgotten draft — so a retention floor needs to apply regardless.
The `or` block fires independently of the top-level AND group:
wolfdesk's `or: { after: { days: 365 } }` retires any ticket that
has lingered a year, whether or not it ever reached `TicketClosed`
or `TicketResolved`. The two paths are evaluated separately, so a
ticket retires on whichever fires first. Mix and match: a pure-OR
policy with no top-level fields (`{ or: { is, after, reaches } }`)
closes on any of its triggers independently, and a row-count
threshold (`reaches: N`) retires a cardinality-bounded stream like
a rotating audit log without any domain event at all.

The full set of fields (`after: { days }`, `is: "EventName"` or
`is: string[]`, `reaches: N`, and the independent rolling-window
`keep: { days }`), the AND/OR composition rules, and where to go
when the declarative form can't express the condition are
documented at
[docs/docs/guides/close-policies.md](../../../docs/docs/guides/close-policies.md).

## What this buys you

Steady state. An events table with a close policy reaches a size
that's roughly active streams × average events per active stream.
Closed streams shed their history continuously, the table doesn't
grow without bound, and the operational properties that scale with
table size stop being scary.

The exact savings depend on your workload's terminal rate and
cooldown window, so measure for yourself. Order-of-magnitude
guidance from the workloads we've watched closely:

- For a tickets-style app closing 90 days after `Resolved`, steady
  state typically lands at 1–5% of what the unbounded table would
  have grown to after 18–24 months. The bulk of historical rows
  are tickets that resolved more than 90 days ago and have no
  reason to still be in primary storage.

- VACUUM windows shrink in proportion to the table. The
  long-tail autovacuum surprises that show up when a table crosses
  a hundred million rows mostly stop appearing because the table
  no longer crosses that threshold.

- `app.reset()` time scales linearly with events processed.
  Bounded events table → bounded rebuild window. This is the
  cheapest way to bound rebuild — orders of magnitude cheaper
  than partitioning, which is documented at
  [recipes/scaling/partitioning/README.md](../partitioning/README.md)
  as a last resort when close-the-books genuinely can't apply.

For PG-specific perf evidence on the cycle itself (claim latency,
notify→reaction latency, batched truncate cost), see
[libs/act-pg/PERFORMANCE.md](../../../libs/act-pg/PERFORMANCE.md).
Core-level numbers (cache-on-commit, watermark-aware claim,
batched projection replay) are at
[libs/act/PERFORMANCE.md](../../../libs/act/PERFORMANCE.md).

## Pair with `.archives()` if you need history later

The close cycle truncates events out of primary storage. If you
need them in cold storage afterwards — for compliance, analytics,
or just "we might want to look at this in two years" — pair the
declarator with a `.archives(fn)` declarator on the same state.
The archiver runs inside the cycle's guard window: tombstone
committed, archiver awaited, truncate. A throw leaves the stream
guarded but un-truncated, and the cycle retries the candidate
next tick, so a transient S3 outage doesn't lose data.

The host owns idempotency, speed (don't hold the guard with
slow I/O), and storage durability. The framework only knows the
archiver resolved. See
[recipes/scaling/archival/README.md](../archival/README.md) for
the recipe; the architectural contract is at
[docs/docs/guides/close-policies.md § The archive contract](../../../docs/docs/guides/close-policies.md).

## What this recipe is NOT for

**Hard real-time close.** The autoclose reaction closes shortly
after the policy qualifies, not synchronously with the commit.
If the close has to happen in the same request that emitted the
terminal event — regulatory cutoffs measured in seconds, "user
deleted my account, the data must be gone now" workflows — call
`app.close([{ stream }])` directly from the action handler. For the in-between case where eventual is too slow but a
per-request close is overkill, narrow the off-hours
`autocloseWindow` (or drop it) — the reaction evaluates on the
aggregate's own commits and parks only while the window is shut.

**Stream rotation while keeping the entity alive.** An online
terminate always tombstones. For a long-running business entity
that needs its history rotated but stays live, two tools exist:
`app.close({ stream, restart: true })` collapses everything to a
fresh snapshot in one shot, and `.autocloses({ keep: { days: N } })`
maintains a rolling window of real events continuously (a
multi-year customer relationship where the last year of activity
is hot and older history is reference-only maps to
`keep: { days: 365 }` plus `.archives`). See
[docs/docs/guides/close-policies.md § keep](../../../docs/docs/guides/close-policies.md)
and the [archival recipe](../archival/README.md).

**Cross-state coordination.** Each state's predicate sees only
its own candidates. "Close stream A only after B is closed"
patterns belong in the host scheduler, not in `.autocloses(...)`.

## Examples in this folder

- [examples/ticket-cooldown.ts](examples/ticket-cooldown.ts) —
  imports the canonical wolfdesk `app` and asserts
  `app.registry.autoclose_policy("Ticket")` is registered, a
  wiring check against the real model. The Ticket policy carries
  both the 90-day cooldown AND-group and the 365-day
  retention-floor `or` backstop.

It compiles against `@rotorsoft/act` as published and runs with
`tsx` — no database needed to verify the declarator wires up.
