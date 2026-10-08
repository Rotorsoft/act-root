/**
 * @module close-lock
 * @category Internal
 *
 * Per-stream serialization for close critical sections, so two closers of
 * the same stream (a manual `app.close` has no drain lease to exclude an
 * autoclose) never prune or archive concurrently, while different streams
 * proceed in parallel.
 *
 * @internal
 */

/** One instance per Act; holds each stream's close tail. */
export class CloseLock {
  private readonly _tails = new Map<string, Promise<unknown>>();

  /** Run `work` after every earlier close of `stream` has settled. */
  run<T>(stream: string, work: () => Promise<T>): Promise<T> {
    const prev = this._tails.get(stream) ?? Promise.resolve();
    // Chain after the previous holder however it settled, so a failed close
    // can't wedge the lock.
    const next = prev.then(work, work);
    this._tails.set(stream, next);
    // Drop the tail once settled, unless a later waiter replaced it.
    const cleanup = () => {
      if (this._tails.get(stream) === next) this._tails.delete(stream);
    };
    next.then(cleanup, cleanup);
    return next;
  }
}
