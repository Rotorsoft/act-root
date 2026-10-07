# ACT-1804: Polling that only looked

## The pain that started it

The first simplicity review asked a plain question of `start_correlations`: who calls it, and what does it do for them? The docs answered generously. Polling was the safety net under `notify`, the path that catches a commit from another process when no wakeup arrives, and the close-policies guide promised it "runs the drain." The code answered differently. Each tick armed the correlate cycle, scanned the log, subscribed the streams the new events targeted, and raised their work marks. Then it stopped. Nothing told the drain controllers there was work, so a process that relied on polling alone discovered every remote commit and never ran a single reaction for it. The suite stayed green because the one test of the poller waited for discovery, which was true, and asked nothing about delivery.

## Why the obvious answer didn't fit

The quick patch was to make the poller arm the drain controllers after its scan, the way `Act.correlate` does. That would have worked, and it would have left two paths doing the same job. The settle loop already ran correlate under the lease, armed whatever the scan marked, drained, looped until nothing moved, fed the circuit breaker, and reported a `settled` event. The poller had grown its own timer, its own scope runner to put the scoped ports back around a callback that fired outside any caller, and its own error logging, all to repeat the first step of that loop. Arming the drain from the poller would have added a fourth piece to a path that should not exist.

## The decision

A tick now does what the cross-process notify handler already did: it says "look anyway" and asks for a settle.

```ts
this._poll = setInterval(() => {
  this._correlate.arm();
  this.settle({ debounceMs: 0, correlate });
}, frequency);
```

Everything else falls away. `CorrelateCycle` loses `start_polling`, `stop_polling`, its timer and the injected scope runner, because settle already runs inside the Act's scope. Errors reach the breaker like every other settle failure instead of a separate log line. The public signature stays: `query` keeps meaning its `limit`, `after` was already ignored because the scan always starts at the checkpoint, and the rarely used `callback` still fires on discovery but is marked deprecated in favour of the `settled` event. One behavior moved deliberately: on a writer-only instance the poll now does nothing, the same as `correlate()` and `settle()` there, where before it scanned for work no local controller would ever drain.

## What this teaches

When a background path and a foreground path do the same job, the background one drifts, because nobody exercises it on the way to a green test. The fix for that drift is rarely to teach the background path the missing step. It is to make it a trigger for the foreground path, so there is one loop to reason about. The same move made the notify handler small, and it is why the shutdown ordering in `1442-shutdown-grace.md` could talk about a single settle cycle rather than two competing ones.

## Connections to other chapters

The settle loop and its breaker are described in `docs/docs/architecture/correlation-and-drain.md`; polling as a safety net under `notify` is in `docs/docs/architecture/cross-process-reactions.md`. The behavior is pinned by the "polling discovers and drains a commit this process never saw" row in `behavior-contracts.md`.
