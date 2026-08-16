# RFC 1486: `subscribe({ correlated_at })` — a subscription-side work set

- **Status:** draft
- **Issue:** #1486
- **Author:** Rotorsoft
- **Created:** 2026-08-15

Gates the public surface for step 3 of [RFC 1449](./1449-split-store-port.md). That RFC argues *why* the subscription side should be told what has work instead of asking the event log; this one fixes the surface, the semantics, and the three questions 1449 deliberately left open.

## Motivation

`claim` answers "which subscribed streams have unconsumed work?" by probing the event log per subscription row. The cost is linear in **subscribed** streams, not in pending work:

| adapter | µs per subscribed stream, per claim, per worker | at 100k streams |
|---|---|---|
| act-pg (after #1448) | ~1.4 | ~130 ms |
| act-sqlite (#1482, measured) | ~11.6 | ~1.2 s |

For the per-aggregate reaction shape (`.to(e => ({ target: e.stream }))`) subscribed streams equals aggregate count, so this is the framework's most common topology. On SQLite the probe is an N+1 in JavaScript inside `transaction("write")`, and #1448's index fix cannot port to it.

The information needed to answer the question already exists: `correlate` walks events forward and resolves each to its targets, then discards the id at which it found the work. `claim` reconstructs it by brute force microseconds later.

## Public surface added

One optional field on an existing port method:

```ts
type SubscribeInput = {
  readonly stream: string;
  readonly source?: string;
  readonly priority?: number;
  readonly lane?: string;
  /**
   * Highest event id observed to resolve to this target. Applied as
   * `correlated_at = GREATEST(correlated_at, value)` — never regresses.
   * Omitted leaves the stored value untouched.
   */
  readonly correlated_at?: number;
};

Store.subscribe(streams: SubscribeInput[]): Promise<{ watermark: number }>;
```

No new port, no new method, no new table. `subscribe` is already the idempotent UPSERT called from the right place, and keeping "record the target" and "record its frontier" in one statement avoids a second round trip per correlated target.

**On the name.** Two halves, each carrying its weight. `correlated` names the only component allowed to write it: not `commit` (the store cannot resolve user-code targets), not `notify` (a best-effort channel cannot be the sole producer), only `correlate` — the one component that sees every event regardless of who wrote it. A name like `pending` or `ready` states a fact about the row; this one states who is entitled to assert it. The `_at` half says what kind of value it is: an event-id watermark, the same id space as a subscription's own `at` and as the global correlate checkpoint `correlated_at` (#1484). The two are the same quantity at different granularity — how far correlate has gotten, globally and per target — so they share a name deliberately.

**On the relationship to `meta.correlation`.** These are two views of one relation, not two unrelated uses of a word.

Correlate computes the edge *prospectively*: applying a reaction's resolver to a source event yields the target stream it routes to. When that reaction commits, `reactingTo` threads the triggering event through, so the resulting events inherit its correlation id and record it as causation — the same edge, *realized*. This field holds the frontier of the prospective relation; `meta.correlation` holds the identity of a realized chain.

They are not interchangeable, and the difference is worth stating because it is where the two views come apart. A correlate edge exists for reactions that commit nothing — a webhook delivery produces no events, so no correlation-tagged commit ever follows it — and a correlation id exists for chains with no reactions at all, such as a single `app.do`. Prospective routing is a property of the registry; realized provenance is a property of the log.

So the shared vocabulary is earned: both name which events are downstream of which. Reading `correlated_at` next to `meta.correlation` should suggest a family resemblance, because there is one.

## Semantics

**Eligibility.** A stream is claimable iff the subscription store says so:

```sql
WHERE blocked = false
  AND (leased_by IS NULL OR leased_until <= NOW())
  AND (deferred_at IS NULL OR deferred_at <= NOW())
  AND at < correlated_at
```

`at < correlated_at` is a valid partial-index predicate — immutable, single-row, no cross-row reference — so the correlated set *is* an index:

```sql
CREATE INDEX act_streams_correlated_at_ix
  ON <schema>.<table>_streams (lane, priority DESC, at)
  WHERE blocked = false AND at < correlated_at;
```

It contains only streams with work; `LIMIT` pushes into it; a stream leaves when `ack` advances `at` to `correlated_at` and re-enters when correlate raises `correlated_at`. `claim` becomes an index scan of at most `lagging + leading` rows: **O(lease budget)**, independent of subscribed-stream count, on every adapter.

**Monotonicity.** `correlated_at` never regresses. `GREATEST` is the whole rule, applied for every value including zero and negatives — the shape of the bug #1445 was on the priority column.

**Honesty.** Correlate sets `correlated_at` to the id of a real event that resolved to that target, so `at < correlated_at` implies a fetch will return work. A mark is a claim about the log, and the producer must not invent one.

## The three open questions, answered

### 1. `correlated_at` lives on the subscription row, not in its own relation

RFC 1449 asked whether a separate `streams_correlated(stream, at)` would be better, since it gives step 6's port split a physical seam.

**On the row.** The seam argument is real but pays now for an option that may never be exercised: a join on the hottest path, a second write per correlated target, and a second thing to keep consistent under `reset`/`unblock`/`truncate`. If step 6 ever happens, moving a column into its own relation is a contained migration — and one the `correlated_at IS NULL` legacy arm below already demonstrates how to stage.

### 2. A stream with no mark is not claimable

This is the definitional answer, and it settles #1446 — the divergence where InMemory and PG short-circuited `at < 0` into claimable while SQLite did not. Under the work set the rule stops being adapter-inferred: **claimable iff a mark says so.**

`NULL` is not `0`: `at < correlated_at` is unknown for a `NULL` mark, so an unmarked row is excluded by SQL's own semantics rather than by a special case, and the legacy arm below is what keeps upgrades working.

The cost is that "claim everything once at boot" stops being available as a recovery tool. That is deliberate — it was never a documented tool, and the reconciliation sweep in question 3 is the supported replacement.

### 3. The reconciliation sweep is operator-invoked, not automatic

Rows that predate the upgrade have `correlated_at IS NULL` and are served by the legacy probe. Once step 5 deletes that arm, a row that correlate never touched would be invisible.

**A new `IAct` method is not the answer** — that grows the charter surface for a one-time migration. The sweep is `correlate` re-run from a floor the operator chooses, which the existing `correlate({ after })` already expresses. Step 5 documents it as a runbook step ("rewind the correlate checkpoint once after upgrading") rather than shipping a button.

Automatic-on-cold-start was rejected: it makes every restart pay for a migration that is finished after the first one, and it hides the one moment an operator would want to see the cost.

## Migration

The column lands via `ADD COLUMN IF NOT EXISTS`, the pattern already used for `priority`, `lane`, and `deferred_at`. Seed-sync is the schema story; there is no migration framework and will not be one.

Bootstrapping existing rows is the real decision:

| Option | Verdict |
|---|---|
| Backfill `correlated_at = MAX(id)` | ❌ Every stream looks pending at once; the whole table drains through empty fetches. |
| Full correlate replay from `-1` on upgrade | ❌ Correct, but an unbounded log scan at startup. |
| **`correlated_at IS NULL` means "unknown — use the legacy probe"** | ✅ Old rows behave exactly as today; every row correlate touches migrates to the fast arm permanently. Zero-risk rollout, and the arm is deleted in step 5. |

## TCK contract

Added in the same PR as the port change (per CLAUDE.md), against InMemory, act-pg, and act-sqlite:

- `subscribe({correlated_at})` then `claim` returns the stream
- mark monotonicity — a lower `correlated_at` does not regress the stored value, across positive, zero, and negative values
- a stream with **no mark** is not claimable
- `ack` advancing `at` to `correlated_at` removes the stream from the claimable set; a later higher mark re-adds it
- `reset` (watermark to `-1`) leaves the mark intact, so a rebuild is claimable
- `unblock`, `defer`, and `prioritize` interact with the mark exactly as they do with the watermark today
- the legacy `correlated_at IS NULL` arm claims via the probe, while it exists

## Stability / charter impact

**Additive, MINOR** — a new optional field on `Store.subscribe`'s input. Every existing adapter compiles and passes unchanged; an adapter that ignores `correlated_at` keeps working through the legacy arm.

**A semantic change with no type diff** — `claim`'s rule moves from "claimable iff the log holds an event past the watermark" to "claimable iff the subscription store holds a mark". Exactly the category the charter exists to catch and exactly the kind a type diff will not surface, so it is called out here and gets behavior-contract rows in step 3.

Docs updated in the same PR: `concurrency-model.md`, `correlation-and-drain.md`, `extension-points.md` (method list **and** semantics), `priority-lanes.md` (ordering applies over the correlated set), `guides/writing-a-store.md`.

## Alternatives considered

- **Commit-side dirty set (outbox).** The store cannot compute the target — `reaction.resolver(event)` is arbitrary user code — and orchestrator-side resolution at commit time misses every event not written through this process (`restore`, replay, a remote writer, a direct `store().commit`).
- **`notify` carries the routing.** It is documented best-effort with capped payloads; a producer allowed to drop signals needs a pull backstop, which reinstates the join.
- **In-memory hot set fed by `notify`.** Per-process, lost on restart, and the O(N) probe remains as the backstop.
- **Bucket the streams table.** A constant-factor win requiring static worker→bucket assignment, surrendering the assignment-free elasticity `SKIP LOCKED` provides.
- **Do nothing.** Leaves SQLite with no path off a linear, write-locked claim — measured at 604 ms per claim at 50k streams (#1482).

## Open questions

None blocking. One to revisit after step 5's numbers: whether `correlated_at` should be capped or compacted for a target that is marked far ahead of its watermark for a long time (a blocked stream accumulating marks). The mark is a single scalar, so there is nothing to grow — but the index churn of a stream repeatedly entering and leaving the correlated set under sustained commit load is the design's principal unknown and is measured in step 5.
