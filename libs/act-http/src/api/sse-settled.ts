import type { BroadcastChannel } from "../sse/broadcast.js";
import { type CommitSource, publishCommits } from "../sse/publish.js";
import type { ActSurface } from "./dispatch.js";

export type { SseSettledFrame } from "./types.js";

/**
 * What the settled frames need from an app: `acked`, which every drain emits
 * with the leases it advanced, whether settle, a retry's backoff, a deferred
 * wake or a lane's cycle ran it.
 */
export type SettledSource = {
  on(
    event: "acked",
    listener: (acked: readonly { stream: string }[]) => void
  ): unknown;
  off(
    event: "acked",
    listener: (acked: readonly { stream: string }[]) => void
  ): unknown;
};

/**
 * Start what `sse.publish`, `sse.settled` and `sse.live` ask of the app:
 * publication of every commit to `channel`, and the source the settled frames
 * read. Refuses any of them on a surface without lifecycle events (`on` and
 * `off`).
 */
export function sse_sources(
  app: ActSurface,
  config: {
    // `any`: one channel carries every state
    readonly channel: BroadcastChannel<any>;
    readonly publish: boolean;
    readonly settled: boolean;
    readonly live: boolean;
  },
  transport: string
): SettledSource | undefined {
  if (!config.publish && !config.settled && !config.live) return undefined;
  if (!app.on || !app.off)
    throw new Error(
      `${transport}: \`sse.publish\`, \`sse.settled\` and \`sse.live\` listen to the app's lifecycle events; pass the built Act.`
    );
  if (config.publish)
    publishCommits(app as unknown as CommitSource, config.channel);
  return config.settled || config.live
    ? (app as unknown as SettledSource)
    : undefined;
}
