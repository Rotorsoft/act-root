import {
  act,
  InMemoryCache,
  InMemoryStore,
  SNAP_EVENT,
  state,
  ZodEmpty,
} from "@rotorsoft/act";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runSseSubscription } from "../../src/api/sse-wiring.js";
import { applyPatchMessage } from "../../src/sse/apply-patch.js";
import { BroadcastChannel } from "../../src/sse/broadcast.js";

const actor = { id: "a", name: "a" };
const Count = state({ Count: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Hit: ZodEmpty })
  .patch({ Hit: (_, s) => ({ n: s.n + 1 }) })
  .on({ hit: ZodEmpty })
  .emit(() => ["Hit", {}])
  .build();

// The same state, snapshotted every second patch.
const Snapped = state({ Snapped: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Hit: ZodEmpty })
  .patch({ Hit: (_, s) => ({ n: s.n + 1 }) })
  .on({ hit: ZodEmpty })
  .emit(() => ["Hit", {}])
  .snap((s) => s.patches >= 2)
  .build();

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// The `committed` listener in the docs. A `.snap` takes the next version, so
// it goes out as an empty patch; otherwise the next commit reads as a gap.
function publish_to(channel: BroadcastChannel<any>) {
  return (snaps: any[]) => {
    const last = snaps.at(-1);
    const patches = snaps.map((s) => s.patch ?? {});
    if (last.version > last.event.version) patches.push({});
    channel.publish(
      last.event.stream,
      { ...last.state, _v: last.version },
      patches
    );
  };
}

// A client that has only the SSE stream: a state frame replaces its baseline,
// a patch goes through applyPatchMessage, and `behind` resubscribes.
function sse_only_client(channel: BroadcastChannel<any>, stream: string) {
  const me = { state: undefined as any, resyncs: 0 };
  let abort = new AbortController();
  const connect = async () => {
    abort = new AbortController();
    for await (const frame of runSseSubscription(
      channel,
      stream,
      undefined,
      abort.signal
    ) as AsyncGenerator<any>) {
      if (frame.kind === "state") {
        me.state = frame.data;
        continue;
      }
      const result = applyPatchMessage(frame.data, me.state);
      if (result.ok) me.state = result.state;
      else if (result.reason === "behind") {
        me.resyncs++;
        abort.abort();
        void connect();
        return;
      }
    }
  };
  void connect();
  return { me, stop: () => abort.abort() };
}

describe("resync after a restart close", () => {
  it("brings an SSE-only client back with the listener in the docs", async () => {
    const app = act()
      .withState(Count)
      .build({
        autoSettle: false,
        scoped: { store: new InMemoryStore(), cache: new InMemoryCache() },
      });
    const channel = new BroadcastChannel<any>();
    app.on("committed", Count, publish_to(channel));
    app.on("closed", ({ truncated }) => {
      for (const [stream, { committed }] of truncated) {
        channel.resync(stream);
        if (committed.name === SNAP_EVENT)
          channel.publish(stream, {
            ...(committed.data as object),
            _v: committed.version,
          });
      }
    });

    for (let i = 0; i < 4; i++) await app.do("hit", { stream: "s", actor }, {});
    const client = sse_only_client(channel, "s");
    await tick();
    expect(client.me.state.n).toBe(4);

    await app.close([{ stream: "s", restart: true }]);
    await tick();
    for (let i = 0; i < 2; i++) {
      await app.do("hit", { stream: "s", actor }, {});
      await tick();
    }
    client.stop();
    const { state: server } = await app.load(Count, "s");
    expect(client.me.state.n).toBe(server.n);
  });
});

describe("broadcast with snapshots", () => {
  it("keeps a live client caught up across a snapshot", async () => {
    const app = act()
      .withState(Snapped)
      .build({
        autoSettle: false,
        scoped: { store: new InMemoryStore(), cache: new InMemoryCache() },
      });
    const channel = new BroadcastChannel<any>();
    app.on("committed", Snapped, publish_to(channel));

    await app.do("hit", { stream: "s", actor }, {});
    const client = sse_only_client(channel, "s");
    await tick();
    for (let i = 0; i < 5; i++) {
      await app.do("hit", { stream: "s", actor }, {});
      await tick();
    }
    client.stop();
    expect(client.me.resyncs).toBe(0);
    expect(client.me.state.n).toBe(6);
  });
});
