# The merge that Postgres was allowed to ignore

`Store.subscribe` has a documented merge rule: when the same stream is
subscribed with different priorities, the maximum wins, so the
highest-priority reaction sets the stream's scheduling priority. Two of the
three adapters implement it with a loop over the batch, applying each entry in
turn. Postgres implements it with one statement, and one statement was where
the rule quietly stopped applying.

The statement is an `UPDATE ... FROM jsonb_array_elements($1)`, joining the
subscriptions table against the batch on stream name. It was written that way
deliberately and for a good reason: correlate calls `subscribe` on every scan
that marks anything, so this is a steady-state round trip, and folding three
column updates into one statement was a measured improvement. The problem is a
rule of `UPDATE ... FROM` that is easy to read past. A target row may be
modified at most once per statement, so when several source rows join to the
same target, Postgres uses one of them and discards the rest. Which one is not
specified. It is not the maximum, and it is not stable across plans.

So a batch naming one stream twice got an arbitrary one of the two entries.
Not a merge, a coin flip.

The interesting part is why a batch would ever name a stream twice, because at
first glance nothing should. The answer is in the classifier: static reaction
targets are keyed by `target|source`, deliberately, because two different
sources feeding one target is a supported configuration with its own test. Two
such reactions produce two entries that share a `stream` and differ in
priority, and correlate's initialization hands the whole list to a single
`subscribe` call. The shape the classifier is designed to produce is exactly the
shape the statement mishandles.

There is a second condition, and it is the reason this went unnoticed for so
long. The statement's `WHERE` clause only admits a row that would actually
change something — a priority strictly above the stored one, a lane change at
or above it, or a mark that advances. So when the stored priority already sits
between the two duplicated entries, only the higher entry qualifies, there is
exactly one matching source row, and the result is correct. A single qualifying
row is the common case, which is why the existing test passes: it subscribes at
3, then 1, then 9, in three separate calls, so the batch never has duplicates
at all.

To see the bug the stored value has to sit *below both* entries, so both
qualify and Postgres gets to choose. That happens on a fresh boot after a
deploy that raises declared priorities, and after a `prioritize()` override
that lowered one — which is the very scenario the restart-driven merge exists
to recover from. It also does not happen on the very first boot, because the
insert seeds the row from one of the entries and the update then has only one
row above it. A bug that needs a prior state and a raise is a bug that shows up
in production and not in a fresh test database.

I want to record the false start, because it cost a round trip. My first probe
subscribed a stream at 3 and then sent `[{priority: 1}, {priority: 9}]` in one
call, expecting 9 and reasoning that the duplicate was enough. It passed. The
`WHERE` had filtered the `1` out, leaving a single qualifying row, and a passing
probe against a real bug is worse than no probe: it argues for closing the
investigation. The lesson generalizes past this ticket. When a statement carries
a filter, a test of its merge logic has to get two rows *past the filter*, not
merely into the payload.

The fix folds the batch to one entry per stream before it reaches SQL, keeping
the maximum priority with its lane and the maximum work mark. Folding in
JavaScript rather than with a `GROUP BY` inside the statement was the choice
because it keeps the single-statement shape the performance work bought, needs
no `DISTINCT ON` gymnastics to carry the winning row's lane, and fixes the
insert as a side effect: a fresh row is now seeded with the maximum rather than
whichever entry the planner reached first.

Two adapters were already correct, and the contract now lives in the shared
compatibility kit rather than in each adapter's own suite, with the duplicates
inside one call. That is where it should have been from the start: the rule is a
property of the port, and a third-party adapter writing its own batched
statement would have walked into precisely this.

Source: `libs/act-pg/src/postgres-store.ts` (`merge_by_stream` and the two
subscribe statements), `libs/act/src/builders/build-classify.ts` (the
`target|source` keying), `libs/act/src/internal/correlate-cycle.ts` (the init
subscribe), cases in `libs/act-tck/src/store-tck.ts` and
`libs/act-pg/test/priority.spec.ts`. Issue #1672.
