# The scan that mistook a quiet page for the end of the log

Act's correlate cycle reads forward through the event log looking for events
that some reaction cares about. When it finds one, it marks the target stream
so the drain can claim it. When it finds nothing, it used to conclude that the
log had nothing more to offer, park itself, and stop reading until something
woke it up. That conclusion was wrong in a way that took a bug hunt to notice,
because it is wrong only when the log is busy with events nobody reacts to.

The park itself was a good idea, and it was recent. Before it, every settle
pass paid for a scan, including the last pass whose only job was to confirm
nothing had changed, and every pass on a system where genuinely nothing was
happening. A flag fixed that. A commit through `do()`, a `reset`, a `notify`
from a peer, or a poll tick raises it; a scan that reaches the end of the log
lowers it. A disarmed correlate returns without touching the store at all.

The trouble is how the scan decided it had reached the end. It asked whether
it had resolved a target, and treated "no targets" as "no more log." That
reasoning holds for a scan with no bound, because a scan that reads to
exhaustion and finds nothing really has seen everything. But no caller scans
without a bound. `app.correlate()` reads a window of ten events. The settle
loop reads a hundred. The poller reads a hundred. Every one of them asks for a
page, and a page is where the reasoning breaks: a window filled entirely with
events that carry no registered reactions looks exactly like an empty log from
the inside.

Most events in a real application have no reactions. That is not a pathology,
it is the normal shape of a domain model, where a handful of events drive
workflows and the rest are simply recorded. So a burst of a hundred ordinary
commits is enough to fill the settle loop's window with silence, and the scan
would park with the reactive event sitting one id past its checkpoint, already
committed, never to be read. The reaction never ran. Nothing was blocked, so
`blocked_streams()` was empty. `await app.settle()` returned reporting that
everything had caught up.

What makes this worth writing down is that the codebase had already
anticipated the exact scenario and defended against it in the wrong place. The
settle loop counts a correlate that advanced its cursor as progress even when
nothing subscribed and nothing drained, and the comment explaining why says
that otherwise "a bounded correlate window full of inert events would break
the loop before a reactive event just past the window is ever scanned." That
is a precise description of this bug. The defense was to run one more pass.
But the extra pass hits the disarmed check and returns without reading
anything, so the cursor does not move, and the loop breaks on the very
condition the guard was written to survive.

There is a second piece of evidence of the same kind. The close path catches up
by calling `arm()` before every pass, and the poller arms unconditionally on
every tick. Both are workarounds by callers who had learned, empirically, that a
parked scan is not a trustworthy claim that the log is exhausted.

The fix is to change what the scan treats as proof. A page that comes back
**short** — fewer events than the limit asked for — really has reached the end,
and that is the only evidence available. So the scan counts what it read and
parks only when the count falls below the limit. A page that fills its window
stays armed, and the next pass continues from the new checkpoint. A page with
no limit is unbounded, so exhausting it always qualifies, which preserves the
one shape the old reasoning was ever correct for.

The commit that introduced the park had already tried something adjacent and
rejected it: gating the disarm on whether `after` had fallen behind the
checkpoint, as a proxy for a caller rewinding the scan. That failed because
`after` is maximized against the checkpoint before use, so the default of `-1`
always matched and the gate never fired. Knowing that saved re-proposing it.
The lesson generalizes past this ticket. Before proposing a fix, read what the
commit that introduced the code already tried, because a commit's reasoning and
its rejected alternatives are different artifacts and only one of them survives
in the final diff.

The deeper pattern is worth naming, because the same bug hunt found its twin in
the drain. Both subsystems short-circuit on an empty result and treat it as
"nothing left to do," and in both the empty result had another explanation. In
correlate it was a bounded window; in drain it was a lease the worker itself
was still holding from the failure it was supposed to retry. An empty result is
evidence about the query, not about the world. When a cycle sets a flag on
purpose, the branch that clears it needs to be sure it is looking at the same
question.

Source: `libs/act/src/internal/correlate-cycle.ts` (the scan and its park),
`libs/act/src/internal/settle.ts` (the progress rule that anticipated this),
tests in `libs/act/test/correlate-armed.spec.ts`. Issue #1669.
