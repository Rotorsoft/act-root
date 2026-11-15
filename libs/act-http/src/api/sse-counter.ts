// The transports' connection cap and best-effort writes. Internal: `hono`
// and `trpc` build and use them; custom transports implement `SseAccounting`.

/**
 * Per-generator concurrent-open counter. Constructed once inside
 * `hono(...)` / `trpc(...)` and consulted at every subscription
 * open: failure to acquire means the cap has been hit and the
 * transport reports `503` / `TOO_MANY_REQUESTS` to the caller.
 *
 * The counter is intentionally process-local. SSE doesn't multiplex
 * across processes; operators wanting more than `maxConnections`
 * viewers run multiple processes behind a sticky load balancer.
 */
export class SseConnectionCounter {
  public readonly limit: number;
  private _open = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  /**
   * Reserve one slot. Returns `true` when accepted (caller must
   * eventually {@link release} the slot, even on error paths) or
   * `false` when the cap is already reached.
   */
  acquire(): boolean {
    if (this._open >= this.limit) return false;
    this._open++;
    return true;
  }

  /**
   * Free a previously-{@link acquire}d slot. Always runs from a
   * `finally` block in the transport's subscription handler so
   * crashed handlers don't leak count.
   */
  release(): void {
    if (this._open > 0) this._open--;
  }

  /** Currently-open count. Test/observability hook. */
  get open(): number {
    return this._open;
  }
}

/**
 * Wrap a fire-and-forget Promise-returning operation so its
 * rejection is swallowed in place of leaking an unhandled
 * rejection. Used by the Hono heartbeat tick (the interval callback
 * isn't `await`ed, so its rejection has nowhere to go) and by any
 * other "best-effort write" the transports run.
 *
 * Pure: same input → same output, no side effects on the caller.
 * Returns the chained Promise so the caller can also `await`
 * completion if they want to (the Hono heartbeat doesn't).
 */
export function fire_and_forget<T>(
  op: () => Promise<T>
): Promise<T | undefined> {
  return op().catch(() => undefined);
}
