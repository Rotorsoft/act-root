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
  /** node-redis(v4+)-shaped fakes capturing the wire protocol. */
  function fakes() {
    const published: Array<{ channel: string; message: string }> = [];
    const listeners = new Map<string, (raw: string) => void>();
    return {
      published,
      listeners,
      publisher: {
        publish: async (channel: string, msg: string) => {
          published.push({ channel, message: msg });
          listeners.get(channel)?.(msg);
          return 1;
        },
      },
      subscriber: {
        subscribe: async (channel: string, listener: (raw: string) => void) => {
          listeners.set(channel, listener);
        },
        unsubscribe: async (channel: string) => {
          listeners.delete(channel);
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
    f.listeners.get(DEFAULT_NOTIFY_CHANNEL)?.("not-json{");
    expect(seen).toEqual([]);
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
