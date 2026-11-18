import type { BroadcastChannel } from "../sse/broadcast.js";
import { type CommitSource, publishCommits } from "../sse/publish.js";
import type { ActSurface } from "./dispatch.js";
import type { SseAccounting } from "./sse-wiring.js";
import { DEFAULT_SSE_MAX_PENDING_PER_CONNECTION } from "./sse-wiring.js";

/** A `$settled` frame: the targets whose drain advanced, once per `settled`. */
export type SseSettledFrame = {
  readonly kind: "settled";
  readonly data: { readonly targets: string[] };
};

/** What a `$settled` subscription needs from an app: its `settled` event. */
export type SettledSource = {
  on(
    event: "settled",
    listener: (drain: { readonly acked: readonly { stream: string }[] }) => void
  ): unknown;
  off(
    event: "settled",
    listener: (drain: { readonly acked: readonly { stream: string }[] }) => void
  ): unknown;
};

/**
 * One `$settled` subscription: a frame each time the app settles with targets
 * that advanced (the projections and reactions a drain acked), so a read-model
 * view refetches once its projection caught up, not on every commit. Frames
 * wait in a queue of at most `max_pending`; when it's full, the newest frame
 * takes the new targets too, so no target is dropped. Shares the transport's
 * connection cap through `accounting`.
 */
export async function* run_settled_subscription(
  app: SettledSource,
  accounting: SseAccounting | undefined,
  signal: AbortSignal | undefined,
  options: { maxPending?: number; on_cap_exceeded?: () => never } = {}
): AsyncGenerator<SseSettledFrame> {
  const acquired = accounting ? accounting.acquire() : false;
  if (accounting && !acquired) options.on_cap_exceeded?.();
  const max_pending =
    options.maxPending ?? DEFAULT_SSE_MAX_PENDING_PER_CONNECTION;
  const pending: string[][] = [];
  let resolve_wait: (() => void) | null = null;
  const listener = (drain: {
    readonly acked: readonly { stream: string }[];
  }) => {
    const targets = [...new Set(drain.acked.map((l) => l.stream))];
    if (!targets.length) return;
    if (pending.length < max_pending) pending.push(targets);
    else {
      const last = pending[pending.length - 1]!;
      pending[pending.length - 1] = [...new Set([...last, ...targets])];
    }
    resolve_wait?.();
  };
  const on_abort = () => resolve_wait?.();
  app.on("settled", listener);
  signal?.addEventListener("abort", on_abort);
  try {
    while (!signal?.aborted) {
      if (pending.length === 0) {
        await new Promise<void>((resolve) => {
          resolve_wait = resolve;
        });
        if (signal?.aborted) break;
      }
      yield { kind: "settled", data: { targets: pending.shift()! } };
    }
  } finally {
    signal?.removeEventListener("abort", on_abort);
    app.off("settled", listener);
    if (acquired) accounting?.release();
  }
}

/**
 * Start what `sse.publish` and `sse.settled` ask of the app: publication of
 * every commit to `channel`, and the source the `$settled` subscriptions read.
 * Refuses either on a surface without lifecycle events (`on` and `off`).
 */
export function sse_sources(
  app: ActSurface,
  config: {
    readonly channel: BroadcastChannel<any>;
    readonly publish: boolean;
    readonly settled: boolean;
  },
  transport: string
): SettledSource | undefined {
  if (!config.publish && !config.settled) return undefined;
  if (!app.on || !app.off)
    throw new Error(
      `${transport}: \`sse.publish\` and \`sse.settled\` listen to the app's lifecycle events; pass the built Act.`
    );
  if (config.publish)
    publishCommits(app as unknown as CommitSource, config.channel);
  return config.settled ? (app as unknown as SettledSource) : undefined;
}
