import type { BroadcastChannel } from "../sse/broadcast.js";
import type { BroadcastState, PatchMessage } from "../sse/types.js";
import { run_live_subscription } from "./sse-live.js";
import { SseOptionsSchema } from "./sse-options.js";

/**
 * SSE wiring options shared by the auto-generated `trpc` and `hono`
 * transports. When supplied, each transport emits one streaming
 * subscription per registered state name, plus `$settled` and `$live` when
 * asked, all reading from the same host-supplied {@link BroadcastChannel}.
 *
 * With {@link publish}, the generator publishes every commit to the
 * channel; without it, the host does, which it needs when the published
 * state carries computed fields. Overlays (`channel.overlay`, such as
 * presence in its own key) survive a publish and don't need it.
 *
 * Defaults are sized for typical business-app dashboards (dozens to
 * hundreds of human viewers per process). The numeric knobs are validated
 * at transport-function construction; out-of-range values throw `ZodError`
 * immediately so misconfiguration surfaces at startup instead of at first
 * connection.
 */
export type SseOptions = {
  /**
   * The {@link BroadcastChannel} the generator's subscriptions hook
   * into. Host owns its lifecycle; the generator does not construct
   * one for you because the channel's `<S>` shape is app-specific and
   * passing it in keeps the type chain typed end-to-end at the host.
   */
  // `any`: one channel carries every state; the generated subscriptions type each state's frames from the app
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
  /**
   * Hard cap on the per-connection in-memory backlog of undelivered
   * broadcast frames. A consumer that stalls (slow client, paused
   * tab) can't drain frames as fast as a busy stream publishes them;
   * without a bound the backlog grows until the process runs out of
   * memory. When a patch finds the backlog full, the stream's pending
   * frames give way to one `_resync`: the consumer refetches and converges
   * on current state, and no frame is lost silently. Every subscription
   * (`subscribe.<State>`, `$settled`, `$live`) follows this one policy.
   *
   * Default `256`. Validated range `[1, 100_000]`.
   */
  readonly maxPendingPerConnection?: number;
  /**
   * Publish every commit to {@link channel} once, as the subscriptions
   * expect (`publishCommits` on `/sse`), instead of the host writing its own
   * `committed` listener. Two generators set to publish to the same
   * channel publish each commit once. Off by default.
   */
  readonly publish?: boolean;
  /**
   * Add one subscription, `$settled` (tRPC `subscribe.$settled`, Hono
   * `GET <basePath>/sse/$settled`), yielding `{ kind: "settled", data: {
   * targets } }` each time a drain advances targets (settle, a retry, a
   * deferred wake or a lane's cycle): the
   * signal a list or dashboard fed by a projection refetches on. It counts
   * against {@link maxConnections}. Off by default.
   */
  readonly settled?: boolean;
  /** Told the number of open subscriptions after every open and close. */
  readonly onConnections?: (count: number) => void;
  /**
   * Add one subscription, `$live` (tRPC `subscribe.$live`, Hono
   * `GET <basePath>/sse/$live`), that follows many streams, and optionally the
   * settled targets, in one feed: one connection per page, whatever it shows.
   * It takes one slot of {@link maxConnections}. Off by default.
   */
  readonly live?: boolean;
  /**
   * The most streams one `$live` subscription follows. Default `50`.
   * Validated range `[1, 1_000]`.
   */
  readonly maxStreamsPerSubscription?: number;
};

/**
 * Frame yielded by the per-state SSE subscription generator. The
 * initial cached state (when present) arrives as `kind: "state"`;
 * every subsequent broadcast publication arrives as `kind: "patch"`
 * with the channel's `PatchMessage` payload.
 */
export type SseSubscriptionFrame<S> =
  | { readonly kind: "state"; readonly data: S }
  | {
      readonly kind: "patch";
      readonly data: S extends BroadcastState ? PatchMessage<S> : unknown;
    };

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
 * Per-subscription knobs for {@link runSseSubscription}, bundled so the
 * two transports (and their tests) pass one options object rather than
 * a growing positional tail.
 */
export type RunSseOptions = {
  /**
   * Invoked when {@link SseAccounting.acquire} returns `false` (the
   * connection cap is full). tRPC throws `TRPCError` here to reject the
   * subscription cleanly from inside the generator; Hono enforces the
   * cap outside the loop and omits this.
   */
  readonly on_cap_exceeded?: () => never;
  /**
   * Upper bound on the per-connection undelivered-frame backlog. When a
   * patch finds it full, the stream's pending frames give way to one
   * `_resync`, and the client refetches. Defaults to
   * {@link DEFAULT_SSE_MAX_PENDING_PER_CONNECTION} when omitted; a value
   * outside `[1, 100_000]` throws `ZodError` before a slot is taken.
   */
  readonly maxPending?: number;
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
  options?: RunSseOptions
): AsyncGenerator<SseSubscriptionFrame<S>> {
  // One stream is a `$live` of one: the same backlog, and the same `_resync`
  // when it overflows.
  // The frame type resolves `PatchMessage<S>` only once `S` is known.
  const max_pending = SseOptionsSchema.shape.maxPendingPerConnection.parse(
    options?.maxPending
  );
  for await (const frame of run_live_subscription(
    channel,
    [{ state: "", stream: stream_id }],
    undefined,
    accounting,
    signal,
    { ...options, maxPending: max_pending }
  ))
    yield { kind: frame.kind, data: frame.data } as SseSubscriptionFrame<S>;
}
