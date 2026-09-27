# The batch that asked the database to decide

Act's `subscribe` registers streams so the drain can claim them. Its documented
merge rule is that when a stream is subscribed with different priorities, the
maximum wins, so the highest-priority reaction sets the stream's scheduling
priority. Postgres implemented that merge with one `UPDATE ... FROM
jsonb_array_elements`, and a rule of `UPDATE ... FROM` is that a target row may
be modified at most once per statement. When several source rows join to the
same target, Postgres uses one of them and discards the rest. Which one is not
specified.

So a batch naming one stream twice got an arbitrary entry instead of the
maximum. The symptom was a stream permanently draining at the wrong priority
after a deploy that raised a declared priority, silently, with nothing in the
audit or the blocked list to show it.

The first fix I wrote folded the batch inside the Postgres adapter, so the
statement only ever saw one row per target. It worked, it was proven red-first
against the other two adapters, and it was the wrong fix. It answered "how do I
make this statement behave" instead of "why is this statement being asked to
merge two rows for one row's worth of data."

Because that is the real question. A subscription is one row per stream. Look at
what the row holds and the shape of the problem changes: `stream` is the key,
and `source` is set once, at creation, and never touched again. InMemory only
passes `source` to the constructor on the insert branch and ignores it for an
existing stream. Postgres inserts with `ON CONFLICT DO NOTHING` and its update
statement does not mention the column. So a second entry for a stream already in
the batch cannot contribute its source on *any* adapter — the data is discarded
everywhere, by design, consistently. All it can contribute is a priority.

That makes a two-entry batch not a merge problem but a malformed input: the
caller is describing two subscriptions where the store can only represent one,
and then asking the adapter to reconcile the difference. Two of the three
adapters happened to reconcile it the documented way because they loop; the one
that batches could not. Blaming the batching adapter is blaming the messenger.

Where did the duplicates come from? The classifier keyed static reaction targets
by `target|source`, so two reactions aimed at one stream from different sources —
a supported configuration with its own test — produced two entries that shared a
stream and differed in priority. Correlate's initialization then handed the whole
list to one `subscribe` call. Notably, correlate's *own* scan path does not do
this: it accumulates into a map keyed by target, so a scan that resolves several
reactions to one stream emits exactly one entry. The engine already knew the
right shape in one place and not in the other.

So the fix is to key the classifier by target too, and keep the max priority
while collapsing. One entry per stream, decided once, in the engine, rather than
three times in three adapters and inconsistently. The Postgres statement needs no
change at all, which is the tell that it was never the culprit. And the port's
doc-comment now says what was previously only implied: at most one entry per
stream, callers de-duplicate, adapters may assume it.

There is a smaller lesson inside the larger one. The adapter-side fold had a
second cost I only found by trying to simplify it. Proving it required a
compatibility-kit case that subscribed a stream with a work mark, and a marked
stream is claimable, and one of that kit's existing tests claims with a bounded
budget from a store it shares with every other case in the block. My new case
pushed the population past the budget and made an unrelated test flake. The
engine-side fix needs no such case — the guarantee is testable as a pure
assertion about what the classifier produces, with no store involved at all. A
fix at the wrong layer had dragged a test into the wrong layer with it.

The general shape, worth keeping: when two implementations of one contract
disagree and the batching one is losing data, check whether the contract is
asking for something the data model can represent. Sometimes the divergence is a
bug in the adapter. Sometimes it is the adapter being the first to notice that
the caller is sending nonsense.

Source: `libs/act/src/builders/build-classify.ts` (the keying),
`libs/act/src/types/ports.ts` (`subscribe`'s uniqueness precondition),
`libs/act/src/internal/correlate-cycle.ts` (the init subscribe and, for
contrast, the scan's own target-keyed map), tests in
`libs/act/test/build-classify.spec.ts` and `libs/act-pg/test/priority.spec.ts`.
Issue #1672.
