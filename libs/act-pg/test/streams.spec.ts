import { dispose, sleep } from "@rotorsoft/act";
import { randomUUID } from "node:crypto";
import { PostgresStore } from "../src";

const table = "streams_test";
const store = new PostgresStore(table, 1_000);

describe("streams", () => {
  beforeAll(async () => {
    await store.drop();
    await store.seed();
  });

  afterAll(async () => {
    await dispose()();
  });

  it("should fetch, lease, and ack", async () => {
    const stream = "baseline";
    await store.commit(
      stream,
      [
        { name: "event", data: { value: "1" } },
        { name: "event", data: { value: "2" } },
        { name: "event", data: { value: "3" } },
      ],
      { correlation: "", causation: {} }
    );

    const { streams, events } = await store.fetch(3);
    expect(streams).toHaveLength(0); // No streams
    expect(events).toHaveLength(3);

    const by = randomUUID();
    const at = events.at(-1)!.id;
    const leased = await store.lease([
      { stream, by, at, retry: 0, block: false },
    ]);
    expect(leased).toHaveLength(1);
    expect(leased[0].stream).toBe(stream);
    expect(leased[0].by).toBe(by);
    expect(leased[0].at).toBe(at);

    await store.ack(leased);
    const fetched = await store.fetch(3);
    expect(fetched.streams).toHaveLength(1);
    expect(fetched.streams[0]).toBe(stream);
    expect(fetched.events).toHaveLength(0);
  });

  it("should not fetch leased streams", async () => {
    const stream = "leased";
    await store.commit(
      stream,
      [
        { name: "event", data: { value: "1" } },
        { name: "event", data: { value: "2" } },
        { name: "event", data: { value: "3" } },
      ],
      { correlation: "", causation: {} }
    );

    const { events } = await store.fetch(3);
    const by = randomUUID();
    const at = events.at(-1)!.id;
    const leased = await store.lease([
      { stream, by, at, retry: 0, block: false },
    ]);
    expect(leased).toHaveLength(1);
    expect(leased[0].stream).toBe(stream);
    expect(leased[0].by).toBe(by);
    expect(leased[0].at).toBe(at);

    const leased2 = await store.lease([
      { stream, by, at, retry: 0, block: false },
    ]);
    expect(leased2).toHaveLength(0);

    await sleep(1_000);
    // lease should have expired by now
    const leased3 = await store.lease([
      { stream, by, at, retry: 0, block: false },
    ]);
    expect(leased3).toHaveLength(1);

    await store.ack(leased3); // to move store watermark to last event 6
  });

  it("should allow concurrency", async () => {
    const stream1 = "concurrent-1";
    const stream2 = "concurrent-2";
    await store.commit(
      stream1,
      [
        { name: "event", data: { value: "1" } },
        { name: "event", data: { value: "2" } },
        { name: "event", data: { value: "3" } },
      ],
      { correlation: "", causation: {} }
    );
    await store.commit(
      stream2,
      [
        { name: "event", data: { value: "1" } },
        { name: "event", data: { value: "2" } },
      ],
      { correlation: "", causation: {} }
    );

    const by = randomUUID();

    const fetch1 = await store.fetch(20);
    expect(fetch1.events).toHaveLength(8); // min watermark is at 3 from baseline stream (11-3=8)
    const at1 = fetch1.events.at(-1)!.id;
    const leased1 = await store.lease([
      { stream: stream1, by, at: at1, retry: 0, block: false },
    ]);
    expect(leased1).toHaveLength(1);
    expect(leased1[0].stream).toBe(stream1);

    const fetch2 = await store.fetch(20);
    expect(fetch2.events).toHaveLength(11); // now min is at -1 from concurrent-1
    const at2 = fetch2.events.at(-1)!.id;
    const leased2 = await store.lease([
      { stream: stream1, by, at: at1, retry: 0, block: false },
      { stream: stream2, by, at: at2, retry: 0, block: false },
    ]);
    expect(leased2).toHaveLength(1); // stream1 should be still leased
    expect(leased2[0].stream).toBe(stream2);

    await store.ack(leased2);
    await store.ack(leased1);

    const fetched3 = await store.fetch(20);
    expect(fetched3.streams).toHaveLength(4); // baseline, leased, and these two
    expect(fetched3.events).toHaveLength(8); // from min 3 of baseline
  });
});
