# The backup that restored a stream to nothing

`app.restore` replaces a store's contents from an event source. The docs call
it an atomic wipe-and-rebuild, promise the target comes out byte-for-byte equal
to the source, and name cross-adapter migration and compaction as the use cases.
It did none of that for any stream that had been snapshotted, and for one class
of stream it silently deleted the whole thing.

The mechanism is a single missing query flag. `scan` walks the source in pages,
asking for `{ after, limit }`, and every adapter filters `__snapshot__` events
out of a query unless the caller sets `with_snaps`. So the walk never saw a
snapshot, which means the sink never received one. For an ordinary stream the
loss is invisible in the small: the domain events all survive, the rebuilt
store folds to the same state, and the next snap policy regenerates a snapshot
eventually. Nothing looks wrong.

The damage shows up where a snapshot is not an optimization but the data. A
windowed close prunes the prefix of a stream below its boundary snapshot,
deliberately, as the retention and archival recipes instruct. After that prune
the stream holds exactly one event, and that event is the snapshot carrying the
folded state. Restore read the stream, found nothing it was willing to carry,
and wrote nothing. The stream vanished from the rebuilt store: no events, no
state, no error, and `kept` simply never counted it. The same is true of a
stream reseeded by `close({restart: true})`, whose seed snapshot is likewise its
only event.

There was a tell sitting in the function the whole time. `scan` contains a
branch that drops snapshots on request, incrementing a counter that surfaces as
`ScanResult.dropped.snapshots`. Against a real store that branch is dead code
and the counter is structurally always zero, because no snapshot ever reaches
it. The documented compaction option — the one whose entire purpose is to strip
snapshots — was a no-op, and its own reporting proved it if anyone had looked.

Why no test caught it is the more instructive part. There are seven cases
covering `drop_snapshots`, and they all pass. They drive `scan` through a
synthetic `EventSource` built for the tests, which honors `after`, `before`,
`limit` and `backward` and ignores `with_snaps` entirely. Snapshots therefore
always reach the walk from that source, the drop branch runs, the counter
increments, and every assertion holds. The CSV tests use a source that ignores
query filters altogether. Nowhere in the repository did a test use a real
`Store` as a restore *source* — the documented primary use case was the one
shape never exercised.

That is a specific and repeatable failure mode, worth naming. A test double
written to satisfy an interface will implement the parts the tests need and
quietly no-op the rest. Every filter it ignores is a filter the production path
applies and the test cannot see. When the code under test *is* the query
construction, a double that ignores queries can only ever confirm the parts that
do not matter.

The fix is to ask for snapshots: `with_snaps: true` on the pagination query, and
on the max-id probe beside it, which had the same omission and was under-
reporting progress whenever the newest event was a snapshot. The rest of the
pipeline already handled snapshots correctly — dense id renumbering, the
causation remap, validation, the sink's own restore — so once they arrive
everything downstream does the right thing, and the dead drop branch comes back
to life and behaves as documented.

Worth noting what the fix does not do. It does not make restore snapshot-aware
in any deeper sense. A snapshot is just an event with a reserved name, the
source holds it, the sink should hold it too, and the only question was whether
the walk was allowed to see it. The bug was not a missing feature but an
unexamined default: `with_snaps` defaults to off because most reads want domain
history, and a backup is the one read that wants everything.

Source: `libs/act/src/internal/event-sourcing.ts` (the paginated walk and the
max-id probe), tests in `libs/act/test/restore.spec.ts`. Issue #1671.
