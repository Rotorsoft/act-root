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

Default Act with no `.autocloses(...)` is also fine. The policy is
opt-in: without the declarator no autoclose reaction exists, and a
happily-bounded fleet pays nothing for the feature. This
recipe is for the workloads that have outgrown default storage.

## The policy

The declarator takes an options object whose fields read like a
sentence. The canonical wolfdesk Ticket
(`packages/wolfdesk/src/ticket-creation.ts`) closes a ticket 90 days
after it resolves, and any ticket that has lingered a year:

```ts
.autocloses({
  is: ["TicketClosed", "TicketResolved"],  // terminal events
  after: { days: 90 },                      // cooldown after terminal
  or: { after: { days: 365 } },             // retention-floor backstop
})
```

Top-level fields combine with AND; the `or` block fires on its own.
The same cooldown shape fits `Delivered` + 14 days on an order or
`Paid` + 7 days on an invoice. Every field (`after`, `is`, `reaches`,
`keep`) and the composition rules are in
[close-policies.md](../../../docs/docs/guides/close-policies.md).

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
  Bounded events table → bounded rebuild window. The flip side: a
  rebuild can only replay what is still in the log. A retired stream
  is gone, and a pruned one keeps only its tail, so only an `.of()`
  state fold (which starts from a kept snapshot) rebuilds correctly
  over closed history. Don't rebuild a read model over closing states
  by truncating it. See [Rebuilding over closed or pruned streams](../../../docs/docs/guides/projections-to-database.md#rebuilding-over-closed-or-pruned-streams). This is the
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
The archiver runs inside the close's guard window: tombstone
committed, archiver awaited, truncate. If it throws, nothing is lost:
the stream stays guarded and un-truncated. The close is not retried
on its own; once the archiver is fixed, `app.close([{ stream }])`
resumes it. See
[recipes/scaling/archival/README.md](../archival/README.md) for the
recipe and
[close-policies.md § The archive contract](../../../docs/docs/guides/close-policies.md#the-archive-contract)
for what the host owns (idempotency, speed, durability).

## What this recipe is NOT for

- **Closing in the same request** as the terminal event: call
  `app.close([{ stream }])` from the handler. The policy closes shortly
  after it qualifies, not synchronously.
- **Rotating a stream while the entity stays alive:** use
  `app.close({ stream, restart: true })` once, or `keep: { days }` for a
  rolling window.
- **Cross-state coordination** ("close A only after B"): that belongs in
  the host's scheduler.
- **Pruning streams that have gone silent:** `keep` rides the stream's
  own commits, so a dormant stream is never pruned. For a retention
  obligation, walk `query_stats` and call `app.close([{ stream, before }])`.

Details and worked examples for each are in
[close-policies.md](../../../docs/docs/guides/close-policies.md).

## Examples in this folder

- [examples/ticket-cooldown.ts](examples/ticket-cooldown.ts) —
  imports the canonical wolfdesk `app` and asserts
  `app.registry.autoclose_policy("Ticket")` is registered, a
  wiring check against the real model. The Ticket policy carries
  both the 90-day cooldown AND-group and the 365-day
  retention-floor `or` backstop.

It compiles against `@rotorsoft/act` as published and runs with
`tsx` — no database needed to verify the declarator wires up.
