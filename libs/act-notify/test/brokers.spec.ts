import type { BrokerMessage } from "../src/index.js";
import {
  DEFAULT_NOTIFY_CHANNEL,
  KafkaBroker,
  LoopbackBroker,
  RedisBroker,
} from "../src/index.js";

const message: BrokerMessage = {
  origin: "o1",
  notification: { stream: "s1", events: [{ id: 1, name: "E" }] },
};

describe("RedisBroker", () => {
  /**
   * node-redis(v4+)-shaped fakes capturing the wire protocol faithfully:
   * `subscribe(channel, listener)` **adds** a listener (multiple allowed per
   * channel), `unsubscribe(channel, listener)` removes only that one, and
   * `unsubscribe(channel)` with no listener removes **all** of them. Modelling
   * a single overwrite-listener would mask the shared-broker bug (#1279).
   */
  function fakes() {
    const published: Array<{ channel: string; message: string }> = [];
    const listeners = new Map<string, Set<(raw: string) => void>>();
    const emit = (channel: string, raw: string) => {
      for (const l of listeners.get(channel) ?? []) l(raw);
    };
    return {
      published,
      listeners,
      emit,
      publisher: {
        publish: async (channel: string, msg: string) => {
          published.push({ channel, message: msg });
          emit(channel, msg);
          return 1;
        },
      },
      subscriber: {
        subscribe: async (channel: string, listener: (raw: string) => void) => {
          const set = listeners.get(channel) ?? new Set();
          set.add(listener);
          listeners.set(channel, set);
        },
        unsubscribe: async (
          channel: string,
          listener?: (raw: string) => void
        ) => {
          const set = listeners.get(channel);
          if (!set) return;
          if (listener) {
            set.delete(listener);
            if (set.size === 0) listeners.delete(channel);
          } else {
            listeners.delete(channel);
          }
        },
      },
    };
  }

  it("round-trips messages over the default channel", async () => {
    const f = fakes();
    const broker = new RedisBroker({
      publisher: f.publisher,
      subscriber: f.subscriber,
    });
    const seen: BrokerMessage[] = [];
    const off = await broker.subscribe((m) => seen.push(m));
    await broker.publish(message);
    expect(f.published[0].channel).toBe(DEFAULT_NOTIFY_CHANNEL);
    expect(seen).toEqual([message]);
    await off();
    expect(f.listeners.size).toBe(0);
  });

  it("honors a custom channel", async () => {
    const f = fakes();
    const broker = new RedisBroker({
      publisher: f.publisher,
      subscriber: f.subscriber,
      channel: "acme:wake",
    });
    await broker.subscribe(() => {});
    await broker.publish(message);
    expect(f.published[0].channel).toBe("acme:wake");
  });

  it("drops malformed payloads without throwing", async () => {
    const f = fakes();
    const broker = new RedisBroker({
      publisher: f.publisher,
      subscriber: f.subscriber,
    });
    const seen: BrokerMessage[] = [];
    await broker.subscribe((m) => seen.push(m));
    f.emit(DEFAULT_NOTIFY_CHANNEL, "not-json{");
    expect(seen).toEqual([]);
  });

  it("disposing one subscriber leaves co-subscribers on a shared broker intact (#1279)", async () => {
    // The sidecar+worker / one-broker-N-workers topology: two orchestrators
    // share a single RedisBroker. Disposing one must remove only its own
    // listener — a channel-wide unsubscribe would silence the other, dropping
    // it to poll-cycle latency until restart.
    const f = fakes();
    const broker = new RedisBroker({
      publisher: f.publisher,
      subscriber: f.subscriber,
    });
    const seenA: BrokerMessage[] = [];
    const seenB: BrokerMessage[] = [];
    const offA = await broker.subscribe((m) => seenA.push(m));
    await broker.subscribe((m) => seenB.push(m));

    // Both wake on the first commit.
    await broker.publish(message);
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);

    // A disposes (graceful sidecar shutdown).
    await offA();

    // A subsequent commit still wakes B — A's dispose removed only A's listener.
    await broker.publish(message);
    expect(seenA).toHaveLength(1); // control: A stopped
    expect(seenB).toHaveLength(2); // B still receiving (bug: was 1)
    // B's listener remains registered on the channel; A's is gone.
    expect(f.listeners.get(DEFAULT_NOTIFY_CHANNEL)?.size).toBe(1);
  });
});

describe("KafkaBroker (scaffold)", () => {
  it("carries its topic but refuses loudly until fan-out semantics land", () => {
    const broker = new KafkaBroker();
    expect(broker.topic).toBe("act-notify");
    expect(new KafkaBroker({ topic: "acme" }).topic).toBe("acme");
    expect(() => broker.publish(message)).toThrow(/scaffold/);
    expect(() => broker.subscribe(() => {})).toThrow(/scaffold/);
  });
});

describe("LoopbackBroker", () => {
  it("fans out to every subscriber and detaches on dispose", () => {
    const broker = new LoopbackBroker();
    const a: BrokerMessage[] = [];
    const b: BrokerMessage[] = [];
    const off_a = broker.subscribe((m) => a.push(m));
    broker.subscribe((m) => b.push(m));
    broker.publish(message);
    expect(a).toEqual([message]);
    expect(b).toEqual([message]);
    off_a();
    broker.publish(message);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
    expect(broker.size).toBe(1);
  });
});
