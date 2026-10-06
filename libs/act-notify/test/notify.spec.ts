import {
  act,
  dispose,
  InMemoryStore,
  log,
  type StoreNotification,
  state,
  store,
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

  describe("a broker that stalls or fails never holds the orchestrator up", () => {
    const never = <T>() => new Promise<T>(() => {});
    const reacting = () =>
      act()
        .withState(Counter)
        .on("Incremented")
        .do(async function reactor() {})
        .to("sink")
        .build();
    const within = (p: Promise<unknown>, ms: number) =>
      Promise.race([
        p.then(() => "resolved"),
        new Promise((r) => setTimeout(() => r("hung"), ms)),
      ]);

    it("shuts down when the broker's unsubscribe never settles", async () => {
      class StalledUnsubscribe extends LoopbackBroker {
        override subscribe(h: Parameters<Broker["subscribe"]>[0]) {
          super.subscribe(h);
          return () => never<void>();
        }
      }
      store(withBroker(new InMemoryStore(), new StalledUnsubscribe()));
      const app = reacting();
      await new Promise((r) => setTimeout(r, 10));
      expect(await within(app.shutdown({ graceMs: 50 }), 1_000)).toBe(
        "resolved"
      );
    });

    it("shuts down when the broker's subscribe never settles", async () => {
      const broker: Broker = {
        publish: () => {},
        subscribe: () => never<() => void>(),
      };
      store(withBroker(new InMemoryStore(), broker));
      const app = reacting();
      expect(await within(app.shutdown({ graceMs: 50 }), 1_000)).toBe(
        "resolved"
      );
    });

    it("stops delivering as soon as the subscription is disposed", async () => {
      const broker = new LoopbackBroker();
      const seen: string[] = [];
      const dispose_sub = await withBroker(new InMemoryStore(), broker).notify(
        (n) => seen.push(n.stream)
      );
      await dispose_sub();
      // a message already in the broker's pipeline arrives after disposal
      broker.publish({
        origin: "remote",
        notification: {
          stream: "late",
          events: [{ id: 1, name: "Incremented" }],
        },
      });
      expect(seen).toEqual([]);
    });

    it("logs subscribe and unsubscribe failures instead of throwing", async () => {
      const warn = vi.spyOn(log(), "warn");
      const rejecting: Broker = {
        publish: () => {},
        subscribe: () => Promise.reject(new Error("no route to broker")),
      };
      const d1 = await withBroker(new InMemoryStore(), rejecting).notify(
        () => {}
      );
      await d1();

      const sync_throw: Broker = {
        publish: () => {},
        subscribe: () => () => {
          throw new Error("unsubscribe exploded");
        },
      };
      const d2 = await withBroker(new InMemoryStore(), sync_throw).notify(
        () => {}
      );
      await d2();

      const async_reject: Broker = {
        publish: () => {},
        subscribe: async () => () =>
          Promise.reject(new Error("unsubscribe timed out")),
      };
      const d3 = await withBroker(new InMemoryStore(), async_reject).notify(
        () => {}
      );
      await d3();

      const string_reject: Broker = {
        publish: () => {},
        subscribe: () => Promise.reject("ECONNREFUSED"),
      };
      const d4 = await withBroker(new InMemoryStore(), string_reject).notify(
        () => {}
      );
      await d4();

      await vi.waitFor(() => {
        const messages = warn.mock.calls.map((c) => String(c[0]));
        expect(
          messages.some((m) => m.includes("subscribe failed: ECONNREFUSED"))
        ).toBe(true);
        expect(
          messages.some((m) => m.includes("subscribe failed: no route"))
        ).toBe(true);
        expect(
          messages.some((m) =>
            m.includes("unsubscribe failed: unsubscribe exploded")
          )
        ).toBe(true);
        expect(
          messages.some((m) =>
            m.includes("unsubscribe failed: unsubscribe timed out")
          )
        ).toBe(true);
      });
      warn.mockRestore();
    });
  });

  describe("delivery to notify handlers", () => {
    const valid = { stream: "s9", events: [{ id: 7, name: "Incremented" }] };

    it("contains a throwing handler so other subscribers still receive, and the commit is unaffected", async () => {
      const broker = new LoopbackBroker();
      const base = new InMemoryStore();
      const listener = withBroker(base, broker);
      const seen: string[] = [];
      await listener.notify(() => seen.push("a"));
      await listener.notify(() => {
        throw new Error("handler bug");
      });
      await listener.notify(() => seen.push("c"));
      const errors = vi.spyOn(log(), "error");
      const warns = vi.spyOn(log(), "warn");

      const remote = withBroker(base, broker);
      const committed = await remote.commit(
        "s9",
        [{ name: "Incremented", data: { by: 1 } }],
        meta
      );
      expect(committed).toHaveLength(1);
      expect(seen).toEqual(["a", "c"]);
      expect(errors).toHaveBeenCalledWith(
        expect.any(Error),
        "Broker notification handler threw"
      );
      // nothing reached the committer as a publish failure
      expect(
        warns.mock.calls.some((c) => String(c[0]).includes("publish failed"))
      ).toBe(false);
      errors.mockRestore();
      warns.mockRestore();
    });

    it("skips malformed notifications and keeps only well-formed events", async () => {
      const broker = new LoopbackBroker();
      const seen: StoreNotification[] = [];
      await withBroker(new InMemoryStore(), broker).notify((n) => seen.push(n));
      const warns = vi.spyOn(log(), "warn");
      const send = (notification: unknown) =>
        broker.publish({ origin: "other", notification } as never);

      send({ stream: 42, events: valid.events });
      send({ stream: "s9" });
      send({ stream: "s9", events: [{ id: "1", name: "X" }, null] });
      send(undefined);
      broker.publish(null as never);
      send({
        stream: "s9",
        events: [
          { id: 7, name: "Incremented", extra: true },
          { name: "no-id" },
        ],
      });

      expect(seen).toEqual([valid]);
      expect(
        warns.mock.calls.filter((c) => String(c[0]).includes("malformed"))
      ).toHaveLength(5);
      warns.mockRestore();
    });
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
