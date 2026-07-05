import { z } from "zod";
import type { BroadcastChannel } from "../sse/broadcast.js";
import type { BroadcastState } from "../sse/types.js";

/**
 * SSE wiring options shared by the auto-generated `trpc` and `hono`
 * transports. When supplied, each transport emits one streaming
 * subscription per registered state name, all reading from the same
 * host-supplied {@link BroadcastChannel}.
 *
 * The host owns publication: every `app.do(...)` call site must
 * forward the resulting snapshots to `channel.publish(...)` for
 * subscribers to see updates. The framework deliberately doesn't
 * auto-publish because the derived state usually needs app-specific
 * overlays (presence, computed fields) that only the host can supply.
 *
 * Defaults are sized for typical business-app dashboards (dozens to
 * hundreds of human viewers per process). Both numeric knobs are
 * validated at transport-function construction; out-of-range values
 * throw `RangeError` immediately so misconfiguration surfaces at
 * startup instead of at first connection.
 */
export type SseOptions = {
  /**
   * The {@link BroadcastChannel} the generator's subscriptions hook
   * into. Host owns its lifecycle; the generator does not construct
   * one for you because the channel's `<S>` shape is app-specific and
   * passing it in keeps the type chain typed end-to-end at the host.
   */
  // `any`: the channel's BroadcastState shape is opaque to the generator — narrowing it would force every state into one structural bound that doesn't fit real apps
  readonly channel: BroadcastChannel<any>;
  /**
   * Hard cap on concurrent open subscriptions per generator
   * instance. The 501st simultaneous open returns `503` (Hono) or
   * throws `TOO_MANY_REQUESTS` (tRPC) — never a silent stall.
   *
   * Default `500`. Validated range `[1, 10_000]`. Above 10k the
   * framework refuses to construct: at that point the FD ceiling
   * and per-connection memory force horizontal scaling regardless
   * of tuning, so the right move is sticky LB + per-process cap,
   * not a higher single-process limit.
   */
  readonly maxConnections?: number;
  /**
   * Keep-alive cadence in milliseconds. Most reverse proxies idle
   * connections out after ~60 seconds; the default `30_000` stays
   * comfortably under.
   *
   * Validated range `[15_000, 300_000]`. Under 15 s wastes
   * bandwidth on a business workload; over 5 min risks proxy drops.
   */
  readonly heartbeatMs?: number;
};

/**
 * Resolved SSE configuration after validation and default expansion.
 * Internal — the resolved values are what every transport actually
 * runs against.
 *
 * @internal
 */
export type SseConfig = {
  readonly channel: BroadcastChannel<BroadcastState>;
  readonly maxConnections: number;
  readonly heartbeatMs: number;
};

/**
 * Default cap on concurrent open subscriptions per generator
 * instance. Sized for typical business-app dashboards (dozens to a
 * few hundred viewers); high enough not to surprise small
 * deployments, low enough not to mask a missing horizontal-scale
 * strategy on big ones.
 */
export const DEFAULT_SSE_MAX_CONNECTIONS = 500;

/**
 * Default keep-alive cadence (30 s). Sits comfortably under the
 * 60 s idle timeout most reverse proxies impose.
 */
export const DEFAULT_SSE_HEARTBEAT_MS = 30_000;

/**
 * Zod schema for the numeric knobs on {@link SseOptions}. Defaults,
 * ranges, and (eventual) integer constraints live in one place — same
 * declarative-validation pattern the rest of the framework uses for
 * configuration shapes.
 *
 * @internal
 */
const SseOptionsSchema = z.object({
  maxConnections: z
    .number()
    .min(1)
    .max(10_000)
    .default(DEFAULT_SSE_MAX_CONNECTIONS),
  heartbeatMs: z
    .number()
    .min(15_000)
    .max(300_000)
    .default(DEFAULT_SSE_HEARTBEAT_MS),
});

/**
 * Validate and apply defaults to host-supplied {@link SseOptions}.
 *
 * Out-of-range values throw at the call site — each transport calls
 * this once at the start of `hono(...)` / `trpc(...)` so
 * misconfiguration surfaces at construction, not at first
 * connection.
 */
export function resolveSseConfig(options: SseOptions): SseConfig {
  const parsed = SseOptionsSchema.parse({
    maxConnections: options.maxConnections,
    heartbeatMs: options.heartbeatMs,
  });
  return {
    channel: options.channel,
    maxConnections: parsed.maxConnections,
    heartbeatMs: parsed.heartbeatMs,
  };
}

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
export function fireAndForget<T>(op: () => Promise<T>): Promise<T | undefined> {
  return op().catch(() => undefined);
}

/**
 * Frame yielded by the per-state SSE subscription generator. The
 * initial cached state (when present) arrives as `kind: "state"`;
 * every subsequent broadcast publication arrives as `kind: "patch"`
 * with the channel's `PatchMessage` payload.
 */
export type SseSubscriptionFrame<S> =
  | { readonly kind: "state"; readonly data: S }
  | { readonly kind: "patch"; readonly data: unknown };

/**
 * Subscription accounting hook. Implementations have a chance to
 * acquire a slot before the loop starts and to release it once the
 * loop's `finally` block runs — used by the tRPC side to enforce
 * `maxConnections` from inside the generator, where it can throw
 * `TRPCError` cleanly. Hono enforces the cap outside the loop (so a
 * full counter returns `503` *before* streamSSE writes headers), then
 * passes `undefined` here.
 */
export type SseAccounting = {
  acquire(): boolean;
  release(): void;
};

/**
 * The shared subscription loop both transports run. Optionally
 * acquires one slot on the supplied {@link SseAccounting}, yields the
 * cached state (when present), then forwards every channel
 * publication as a `kind: "patch"` frame until either the consumer
 * breaks (calling `iter.return()`) or the supplied abort signal fires.
 *
 * Exported as the testable seam — the Hono and tRPC sibling
 * generators wrap this so the signal-driven cleanup and counter
 * accounting live in one place.
 */
// `any`: the channel's BroadcastState shape is opaque to the loop — narrowing it would force every state into one structural bound that doesn't fit real apps
export async function* runSseSubscription<S extends { _v: number } = any>(
  channel: BroadcastChannel<S>,
  stream_id: string,
  accounting: SseAccounting | undefined,
  signal: AbortSignal | undefined,
  on_cap_exceeded?: () => never
): AsyncGenerator<SseSubscriptionFrame<S>> {
  if (accounting && !accounting.acquire() && on_cap_exceeded) {
    on_cap_exceeded();
  }
  const pending: unknown[] = [];
  let resolve_wait: (() => void) | null = null;
  const unsubscribe = channel.subscribe(stream_id, (msg) => {
    pending.push(msg);
    resolve_wait?.();
  });
  const on_abort = () => resolve_wait?.();
  signal?.addEventListener("abort", on_abort);
  try {
    const cached = channel.state(stream_id);
    if (cached !== undefined) {
      yield { kind: "state", data: cached };
    }
    while (!signal?.aborted) {
      if (pending.length === 0) {
        await new Promise<void>((resolve) => {
          resolve_wait = resolve;
        });
        if (signal?.aborted) break;
      }
      const msg = pending.shift();
      yield { kind: "patch", data: msg };
    }
  } finally {
    signal?.removeEventListener("abort", on_abort);
    unsubscribe();
    accounting?.release();
  }
}
