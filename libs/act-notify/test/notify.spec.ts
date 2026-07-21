import {
  act,
  dispose,
  InMemoryStore,
  type StoreNotification,
  state,
} from "@rotorsoft/act";
import { sandbox } from "@rotorsoft/act/test";
import { z } from "zod";
import { type Broker, LoopbackBroker, withBroker } from "../src/index.js";

const meta = { correlation: "t", causation: {} };

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({ Incremented: (e, s) => ({ count: s.count + e.data.by }) })
  .on({ increment: z.object({ by: z.number() }) })
  .emit((a) => ["Incremented", a])
  .build();

describe("withBroker", () => {
  afterEach(async () => {
    await dispose()();
  });

  it("delegates durable methods to the wrapped store untouched", async () => {
    const base = new InMemoryStore();
    const wrapped = withBroker(base, new LoopbackBroker());
    await wrapped.seed();
    const committed = await wrapped.commit(
      "s1",
      [{ name: "Incremented", data: { by: 1 } }],
      meta
    );
    expect(committed).toHaveLength(1);
    const seen: string[] = [];
    await wrapped.query((e) => {
      seen.push(e.name as string);
    });
    expect(seen).toEqual(["Incremented"]);
    await wrapped.dispose();
  });

  it("publishes remote wakeups and filters its own commits", async () => {
    const broker = new LoopbackBroker();
    const base = new InMemoryStore();
    const a = withBroker(base, broker);
    const b = withBroker(base, broker);

    const a_seen: StoreNotification[] = [];
    const b_seen: StoreNotification[] = [];
    const off_a = await a.notify((n) => a_seen.push(n));
    await b.notify((n) => b_seen.push(n));

    await a.commit("s1", [{ name: "Incremented", data: { by: 1 } }], meta);

    // b (remote) woke; a (origin) filtered itself out
    expect(b_seen).toEqual([
      { stream: "s1", events: [{ id: 0, name: "Incremented" }] },
    ]);
    expect(a_seen).toEqual([]);

    // disposer detaches the subscription
    await off_a();
    expect(broker.size).toBe(1);
  });

  it("swallows publish failures — a broker outage never fails a commit", async () => {
    const down: Broker = {
      publish() {
        throw new Error("broker down");
      },
      subscribe() {
        return () => {};
      },
    };
    const wrapped = withBroker(new InMemoryStore(), down);
    const committed = await wrapped.commit(
      "s1",
      [{ name: "Incremented", data: { by: 1 } }],
      meta
    );
    expect(committed).toHaveLength(1);
    // non-Error throwable takes the String(error) leg of the log line
    const weird: Broker = {
      publish() {
        throw "unplugged";
      },
      subscribe() {
        return () => {};
      },
    };
    const wrapped2 = withBroker(new InMemoryStore(), weird);
    await expect(
      wrapped2.commit("s2", [{ name: "Incremented", data: { by: 2 } }], meta)
    ).resolves.toHaveLength(1);
  });

  it("does not block commit on a hung broker publish — the hint never gates the durable write", async () => {
    // Broker connected but unresponsive: publish returns a promise that
    // never settles (network partition / overloaded Redis / GC pause).
    const hung: Broker = {
      publish: () => new Promise<void>(() => {}),
      subscribe: () => () => {},
    };
    const base = new InMemoryStore();
    const wrapped = withBroker(base, hung);
    // Would hang forever if commit awaited the publish; resolves now.
    const committed = await wrapped.commit(
      "s1",
      [{ name: "Incremented", data: { by: 1 } }],
      meta
    );
    expect(committed).toHaveLength(1);
    // The durable write landed regardless of the stalled hint channel.
    const seen: string[] = [];
    await base.query((e) => {
      seen.push(e.name as string);
    });
    expect(seen).toEqual(["Incremented"]);
  });

  it("swallows an async publish rejection without failing the commit", async () => {
    // node-redis-shaped broker whose publish rejects asynchronously.
    const rejecting: Broker = {
      publish: () => Promise.reject(new Error("redis unreachable")),
      subscribe: () => () => {},
    };
    const wrapped = withBroker(new InMemoryStore(), rejecting);
    await expect(
      wrapped.commit("s1", [{ name: "Incremented", data: { by: 1 } }], meta)
    ).resolves.toHaveLength(1);
  });

  it("skips the publish when a commit lands no events", async () => {
    const broker = new LoopbackBroker();
    let published = 0;
    broker.subscribe(() => published++);
    const wrapped = withBroker(new InMemoryStore(), broker);
    await wrapped.commit("s1", [], meta);
    expect(published).toBe(0);
  });

  it("wakes a full orchestrator on a remote commit", async () => {
    const broker = new LoopbackBroker();
    const base = new InMemoryStore();

    const handled: string[] = [];
    const builder = act()
      .withState(Counter)
      .on("Incremented")
      .do(async function reactor(event) {
        handled.push(event.stream);
      })
      .to((e) => ({ target: `r:${e.stream}`, source: e.stream }));

    const ctx = await sandbox(builder, {
      store: () => withBroker(base, broker),
    });
    try {
      const notified = new Promise<StoreNotification>((resolve) =>
        (
          ctx.app as unknown as {
            on: (e: string, h: (n: StoreNotification) => void) => void;
          }
        ).on("notified", resolve)
      );

      // a remote worker (different origin, same base store) commits
      const remote = withBroker(base, broker);
      await remote.commit(
        "order-9",
        [{ name: "Incremented", data: { by: 5 } }],
        meta
      );

      const n = await notified;
      expect(n.stream).toBe("order-9");
      // The wake IS the pipeline: the notification arms and settles the
      // orchestrator, no manual correlate/drain — just convergence.
      await vi.waitFor(() => expect(handled).toContain("order-9"), {
        timeout: 3_000,
      });
    } finally {
      await ctx.dispose();
    }
  });
});
