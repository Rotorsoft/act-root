import type { BroadcastChannel } from "./broadcast.js";
import type { BroadcastState } from "./types.js";

/** The parts of a committed snapshot publication reads. */
type CommittedSnapshot = {
  readonly state: unknown;
  readonly version: number;
  readonly patch?: unknown;
  readonly event?: { readonly stream: string; readonly version: number };
};

/**
 * What {@link publishCommits} needs from an app: its `committed` event. Typed
 * structurally, so this subpath never imports the framework and stays safe
 * to bundle for the browser.
 */
export type CommitSource = {
  on(
    event: "committed",
    listener: (snapshots: CommittedSnapshot[]) => void
  ): unknown;
  off(
    event: "committed",
    listener: (snapshots: CommittedSnapshot[]) => void
  ): unknown;
};

// One publication per app and channel: a second call (a tRPC and a Hono
// generator both set to publish) reuses the first listener.
const publishers = new WeakMap<object, WeakMap<object, () => void>>();

/**
 * Publish every commit of `app` to `channel` once, as the clients' patch
 * stream expects: the stream's patches in order, then an empty patch when
 * `.snap` took a version, so a live client doesn't read the next commit as a
 * gap; the state carries `_v`, the stream's version. `committed` fires once
 * per stream a commit appended to, so each call publishes one stream.
 *
 * Calling it again for the same app and channel publishes nothing more and
 * returns the same disposer.
 *
 * @returns A function that stops publishing.
 */
export function publishCommits(
  app: CommitSource,
  channel: BroadcastChannel<any>
): () => void {
  const of_app = publishers.get(app) ?? new WeakMap<object, () => void>();
  publishers.set(app, of_app);
  const existing = of_app.get(channel);
  if (existing) return existing;
  const listener = (snapshots: CommittedSnapshot[]) => {
    // Fired only with committed snapshots: each carries its patch, and the
    // last one and its event exist.
    const last = snapshots.at(-1)!;
    const patches = snapshots.map((s) => s.patch as object);
    if (last.version > last.event!.version) patches.push({});
    channel.publish(
      last.event!.stream,
      { ...(last.state as object), _v: last.version } as BroadcastState,
      patches
    );
  };
  app.on("committed", listener);
  const dispose = () => {
    app.off("committed", listener);
    of_app.delete(channel);
  };
  of_app.set(channel, dispose);
  return dispose;
}
