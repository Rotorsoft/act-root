import type { BroadcastChannel } from "./broadcast.js";
import type { BroadcastState } from "./types.js";

/** The parts of a committed snapshot publication reads. */
type CommittedSnapshot = {
  readonly state: unknown;
  readonly version: number;
  readonly patch?: unknown;
  readonly event?: {
    readonly name: string;
    readonly stream: string;
    readonly version: number;
  };
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
// generator both set to publish) reuses the first listener and widens its
// filter to the second call's events (`undefined` is every event).
type Publisher = { dispose: () => void; events: Set<string> | undefined };
const publishers = new WeakMap<object, WeakMap<object, Publisher>>();

/**
 * Publish every commit of `app` to `channel` once, as the clients' patch
 * stream expects: the stream's patches in order, then an empty patch when
 * `.snap` took a version, so a live client doesn't read the next commit as a
 * gap; the state carries `_v`, the stream's version. `committed` fires once
 * per stream a commit appended to, so each call publishes one stream.
 *
 * With `events`, only commits of those event names are published: a state
 * the channel doesn't serve, a sensitive one above all, never reaches it.
 *
 * Calling it again for the same app and channel returns the same disposer
 * and publishes each commit once; the events published are those any call
 * named (every event, once a call names none).
 *
 * @returns A function that stops publishing.
 */
export function publishCommits(
  app: CommitSource,
  // `any`: one channel carries every state
  channel: BroadcastChannel<any>,
  options?: { readonly events?: Iterable<string> }
): () => void {
  const of_app = publishers.get(app) ?? new WeakMap<object, Publisher>();
  publishers.set(app, of_app);
  const existing = of_app.get(channel);
  if (existing) {
    if (!options?.events) existing.events = undefined;
    else if (existing.events)
      for (const name of options.events) existing.events.add(name);
    return existing.dispose;
  }
  const publisher: Publisher = {
    dispose: () => {},
    events: options?.events && new Set(options.events),
  };
  const listener = (snapshots: CommittedSnapshot[]) => {
    // Fired only with committed snapshots: each carries its patch, and the
    // last one and its event exist. One call is one stream, of one state.
    const last = snapshots.at(-1)!;
    if (publisher.events && !publisher.events.has(last.event!.name)) return;
    const patches = snapshots.map((s) => s.patch as object);
    if (last.version > last.event!.version) patches.push({});
    channel.publish(
      last.event!.stream,
      { ...(last.state as object), _v: last.version } as BroadcastState,
      patches
    );
  };
  app.on("committed", listener);
  publisher.dispose = () => {
    app.off("committed", listener);
    of_app.delete(channel);
  };
  of_app.set(channel, publisher);
  return publisher.dispose;
}
