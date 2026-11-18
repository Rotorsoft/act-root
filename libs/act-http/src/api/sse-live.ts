import type { BroadcastChannel } from "../sse/broadcast.js";
import { resync_frame } from "../sse/frames.js";
import type { PatchMessage } from "../sse/types.js";
import type { SettledSource, SseSettledFrame } from "./sse-settled.js";
import type { SseAccounting } from "./sse-wiring.js";
import { DEFAULT_SSE_MAX_PENDING_PER_CONNECTION } from "./sse-wiring.js";

/** One stream a `$live` subscription follows, with the state it belongs to. */
export type LiveSource = { readonly state: string; readonly stream: string };

/**
 * A `$live` frame: one stream's cached state or patch, tagged with its state
 * and stream, or the targets a settle advanced.
 */
export type SseLiveFrame =
  | {
      readonly kind: "state";
      readonly state: string;
      readonly stream: string;
      readonly data: unknown;
    }
  | {
      readonly kind: "patch";
      readonly state: string;
      readonly stream: string;
      readonly data: unknown;
    }
  | SseSettledFrame;

/**
 * One `$live` subscription: the patches of every source stream and, with a
 * settled source, the targets each settle advanced, in one feed that takes
 * one slot of the connection cap.
 *
 * Every source starts with its cached state, when the channel has one. The
 * frames share one queue of `max_pending`. When a stream's patch finds it
 * full, that stream's pending frames give way to one `_resync`, so its
 * versions never skip silently and the other streams keep theirs; the queue
 * can run over by at most one such frame per stream. A settle that finds it
 * full joins the newest pending `settled` frame.
 */
export async function* run_live_subscription(
  // `any`: one channel carries every state; the frames are typed by the generators
  channel: BroadcastChannel<any>,
  sources: readonly LiveSource[],
  settled: SettledSource | undefined,
  accounting: SseAccounting | undefined,
  signal: AbortSignal | undefined,
  options: { maxPending?: number; on_cap_exceeded?: () => never } = {}
): AsyncGenerator<SseLiveFrame> {
  const acquired = accounting ? accounting.acquire() : false;
  if (accounting && !acquired) options.on_cap_exceeded?.();
  const max_pending =
    options.maxPending ?? DEFAULT_SSE_MAX_PENDING_PER_CONNECTION;
  const pending: SseLiveFrame[] = [];
  let resolve_wait: (() => void) | null = null;
  const wake = () => resolve_wait?.();

  const enqueue_patch = (source: LiveSource, msg: PatchMessage<any>) => {
    if (pending.length < max_pending) {
      pending.push({ kind: "patch", ...source, data: msg });
      return wake();
    }
    for (let i = pending.length - 1; i >= 0; i--) {
      const frame = pending[i]!;
      if (frame.kind !== "settled" && frame.stream === source.stream)
        pending.splice(i, 1);
    }
    pending.push({ kind: "patch", ...source, data: resync_frame() });
    wake();
  };
  const on_settled = (drain: {
    readonly acked: readonly { stream: string }[];
  }) => {
    const targets = [...new Set(drain.acked.map((l) => l.stream))];
    if (!targets.length) return;
    let last = pending.length - 1;
    while (last >= 0 && pending[last]!.kind !== "settled") last--;
    if (pending.length >= max_pending && last >= 0) {
      const frame = pending[last] as SseSettledFrame;
      pending[last] = {
        kind: "settled",
        data: { targets: [...new Set([...frame.data.targets, ...targets])] },
      };
    } else pending.push({ kind: "settled", data: { targets } });
    wake();
  };

  const unsubscribes = sources.map((source) =>
    channel.subscribe(source.stream, (msg) => enqueue_patch(source, msg))
  );
  settled?.on("settled", on_settled);
  signal?.addEventListener("abort", wake);
  try {
    for (const source of sources) {
      const cached = channel.state(source.stream);
      if (cached !== undefined)
        yield { kind: "state", ...source, data: cached };
    }
    while (!signal?.aborted) {
      if (pending.length === 0) {
        await new Promise<void>((resolve) => {
          resolve_wait = resolve;
        });
        if (signal?.aborted) break;
      }
      yield pending.shift()!;
    }
  } finally {
    signal?.removeEventListener("abort", wake);
    for (const unsubscribe of unsubscribes) unsubscribe();
    settled?.off("settled", on_settled);
    if (acquired) accounting?.release();
  }
}

/**
 * The sources a `$live` request names, checked: every state must be one the
 * transport serves, every stream must match its state's pattern when it has
 * one, a stream belongs to one state, and the request must name something,
 * within `max_streams`. A state listed with no streams (`undefined`) names
 * none. Returns the refusal's message, or the sources with each stream once.
 */
export function live_sources(
  request: {
    readonly streams?: Readonly<Record<string, readonly string[] | undefined>>;
    readonly settled?: boolean;
  },
  served: ReadonlySet<string>,
  patterns: Readonly<
    Record<string, RegExp | ((stream: string) => boolean) | undefined>
  >,
  max_streams: number
): { sources: LiveSource[] } | { refused: string } {
  const sources = new Map<string, LiveSource>();
  for (const [state, streams] of Object.entries(request.streams ?? {})) {
    if (!streams) continue;
    if (!served.has(state)) return { refused: `no live state "${state}"` };
    const pattern = patterns[state];
    for (const stream of streams) {
      const matches =
        typeof stream === "string" &&
        stream.length > 0 &&
        (!pattern ||
          (pattern instanceof RegExp ? pattern.test(stream) : pattern(stream)));
      if (!matches)
        return { refused: `"${String(stream)}" is not a stream of ${state}` };
      const listed = sources.get(stream);
      if (listed && listed.state !== state)
        return {
          refused: `"${stream}" is listed under both ${listed.state} and ${state}`,
        };
      sources.set(stream, { state, stream });
    }
  }
  if (!sources.size && !request.settled)
    return { refused: "name at least one stream, or settled" };
  if (sources.size > max_streams)
    return {
      refused: `${sources.size} streams, more than the ${max_streams} a subscription follows`,
    };
  return { sources: [...sources.values()] };
}
