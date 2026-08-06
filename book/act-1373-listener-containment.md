# The observer that took down the observed

There is a rule about instrumentation that sounds too obvious to write down: watching a thing must not change it. The drain cycle broke that rule in the most expensive way available, and it did so through three lines that look like nothing.

At the end of a drain, once the acks and blocks are durable, the cycle tells the world what happened. It calls the acked sink, the blocked sink, and then, if a reaction asked for one, it awaits a close. Those three calls sat inside the same `try` that wraps the store work, and the `catch` on that `try` does what a catch around store work should do: it records a failure on the circuit breaker, which logs the error and emits the public `error` lifecycle event, and it returns an empty drain result so the worker tick stays exception-free.

So a listener that throws was indistinguishable from Postgres going away.

Follow what that costs. A stream hits a `NonRetryableError` and is durably blocked; the row is written, the flag is set. The cycle then calls the acked sink for the streams that succeeded, and some metrics bridge in that sink throws because a field it expected was undefined. Control leaves the finalize block. The blocked sink is never called, so the `blocked` lifecycle event never fires. The breaker records a store failure that did not happen. The caller receives an empty drain and concludes nothing occurred.

The part that turns an annoyance into a defect is that none of this is retried. `Store.block` is guarded on `blocked = false` on all three adapters, and a blocked stream is excluded from `claim`. The block already happened; it will not happen again. There is no second chance to emit the event. An operator watching `act_reactions_blocked_total` — the metric whose entire job is to page someone when a stream is poisoned — sees zero, forever, for a stream that is poisoned forever. The system is in exactly the state the alert exists to detect, and the alert cannot fire, because the thing that would have fired it was the thing that broke.

The close sink is worse in a quieter way. It runs after the acked sink, and by then the event that requested the close has been durably acked. If a throwing `acked` listener prevents the close from running, the reaction that would have requested it again never re-fires. An `.autocloses` policy silently does not close, and there is no signal anywhere that it was supposed to.

What makes this a mistake rather than a trade-off is that the framework had already decided the question. The `notified` handler in the orchestrator wraps its emit in a try/catch under a comment that says, in as many words, that listener error containment lives here so the store's listener stays alive. The intent was settled. The drain finalize path simply never received it, and nothing in the test suite noticed, because the only listener-throw test in the repository asserts the opposite of the buggy behavior on a different path.

The fix is to contain each sink separately. Separately matters more than it first appears: containing all three in one block would mean a bad acked listener still swallows the blocked event and the close, which is most of the original bug wearing a smaller hat. Each sink gets its own guard, logs what it caught, and the cycle proceeds to the next one.

One thing the fix deliberately does not do is contain everything that happens under the close. `on_close` runs real close machinery, and a genuine store failure in there is a real store failure that the breaker should see. Only the emit is an observer concern. The line between the two is the line the fix draws.

The general shape is worth naming, because it will happen again somewhere else. A `try` block accumulates statements over time, and its `catch` was written for the statements that were there first. Every statement added afterward inherits an error policy that nobody re-derived for it. Here the policy was "the store failed, tell the breaker," and the new statements were "tell the observers" — a category the policy had no business covering. The bug is not in either half. It is in the boundary that stopped being examined.
