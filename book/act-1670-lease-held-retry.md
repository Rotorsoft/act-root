# The retry that waited on a lease it was holding itself

Act's drain cycle leases a stream, dispatches its events to the registered
reactions, then decides what to do with the outcome. When a handler throws and
the stream still has retry budget left, the cycle deliberately submits no ack.
That is the right call: the watermark must not advance past an event whose
side effect never happened, so the events stay pending and the stream gets
another attempt. The error path even leaves the controller's armed flag up,
with a comment saying so, precisely to let the retry flow through the next
drain.

The next drain claimed nothing, and concluded it was caught up.

The reason is a detail of how leases work that is easy to hold backwards. Not
acking means not releasing the lease, and every adapter's `claim` excludes a
stream whose lease has not lapsed. There is no exemption for the worker that
holds it. So for the remainder of `leaseMillis`, the one stream that needs
re-dispatching is invisible to the only worker that wants to dispatch it. The
claim comes back empty, and the empty-claim branch reads that as "fully caught
up" and clears the armed flag the error path had just set on purpose. Once
disarmed, the controller's own tick stops calling drain. When the lease finally
lapses, nothing is left listening.

What makes this worse than a missed retry is how ordinary the trigger is. The
default lease is ten seconds, and `settle()` loops correlate and drain until a
pass makes no progress, which means its second pass lands inside the window
essentially always. A single `await app.settle()` on stock defaults was enough:
one attempt, no retry, and because the stream never reached the point where
`blockOnError` is consulted, no block either. `blocked_streams()` stayed empty.
Nothing anywhere reported a stalled stream. The failure was not that the
framework gave up too early, it was that the framework stopped counting.

The reason this survived the test suite is worth a paragraph of its own. There
are good retry tests, and they all drain with `leaseMillis: 1`. With a
one-millisecond lease the window has already closed by the time the next call
runs, so the empty claim never happens and every assertion about retry
behaviour holds. The lease duration looked like an irrelevant detail to make
small, and it was the whole mechanism. A test can exercise the right code path
and still be blind to the bug if it optimizes away the timing the bug lives in.

There is also a quieter irony in the shape of the fix. The `backoff` option was
already immune, because a paced retry persists its next-attempt time and parks
the stream in a process-local timer whose wake re-arms the drain. So an
optional knob, added to slow retries down for flaky external systems, was the
only thing keeping the default retry path alive. Configuring `backoff` made
retries work; omitting it made them stop.

So the fix is to make the default path use the mechanism the paced path already
had. A failing, non-blocked stream now parks in the same timer, at its backoff
time when one is configured and at the lease expiry when one is not. The wake
re-arms the drain, the two error paths stop diverging, and the sentence already
written on `HandleResult.next_attempt_at` — "undefined means no backoff
configured, drain re-attempts as soon as the lease expires" — becomes true
rather than aspirational.

One rejected alternative is worth recording, because it looks like the obvious
one. Instead of parking, release the lease on a no-progress failure by acking
at the stream's current watermark. That would make the stream immediately
claimable and needs no timer at all. It also resets `retry` to -1, because a
non-due ack is how the adapters signal success, so the budget would never
accrue and `blockOnError` would never fire. That trades this bug for #1418's,
which is the one where a stream retries forever without ever blocking. The
lease is not merely a lock here; holding it is what remembers that an attempt
failed.

The general lesson pairs with #1669, found in the same sweep. Both are
short-circuits on an empty result that treat it as a statement about the world
rather than about the query. In correlate the empty page was a bounded window;
here the empty claim was a lease this very worker was holding. When a branch
concludes "there is nothing to do," it is worth asking what else could have
produced that silence.

Source: `libs/act/src/internal/drain-cycle.ts` (the park block and the
empty-claim branch), `libs/act/src/builders/reaction-builder.ts` (the finalize
that sets `next_attempt_at`), tests in `libs/act/test/backoff.spec.ts`.
Issue #1670.
