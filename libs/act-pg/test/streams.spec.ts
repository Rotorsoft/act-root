import { dispose, sleep } from "@rotorsoft/act";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/index.js";

describe("streams", () => {
  let store: PostgresStore;

  beforeAll(async () => {
    store = new PostgresStore({
      port: 5431,
      schema: "streams_test_schema",
      table: "streams_test",
      leaseMillis: 1_000,
    });
    await store.drop(); // drop schema
    await store.seed(); // create schema
  });

  afterAll(async () => {
    await dispose()();
  });

  it("should poll, lease, and ack", async () => {
    const stream = "baseline";
    const events = await store.commit(
      stream,
      [
        { name: "event", data: { value: "1" } },
        { name: "event", data: { value: "2" } },
        { name: "event", data: { value: "3" } },
      ],
      { correlation: "", causation: {} }
    );

    const streams = await store.poll(3);
    expect(streams).toHaveLength(0); // No streams

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
    const fetched = await store.poll(3);
    expect(fetched).toHaveLength(1);
  });

  it("should not fetch leased streams", async () => {
    const stream = "leased";
    const events = await store.commit(
      stream,
      [
        { name: "event", data: { value: "1" } },
        { name: "event", data: { value: "2" } },
        { name: "event", data: { value: "3" } },
      ],
      { correlation: "", causation: {} }
    );

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
    // This test checks that multiple streams can be polled, leased, and acked concurrently
    // and that the store correctly tracks the state of each stream.
    const stream1 = "concurrent-1";
    const stream2 = "concurrent-2";
    // Commit 3 events to stream1
    await store.commit(
      stream1,
      [
        { name: "event", data: { value: "1" } },
        { name: "event", data: { value: "2" } },
        { name: "event", data: { value: "3" } },
      ],
      { correlation: "", causation: {} }
    );
    // Commit 2 events to stream2
    await store.commit(
      stream2,
      [
        { name: "event", data: { value: "1" } },
        { name: "event", data: { value: "2" } },
      ],
      { correlation: "", causation: {} }
    );

    const by = randomUUID();

    // Poll for all available streams (should be 2: stream1 and stream2)
    const poll1 = await store.poll(20);
    expect(poll1).toHaveLength(2); // 2 streams: stream1 and stream2
    const at1 = poll1[0].at;

    // Lease stream1 (simulate a consumer taking stream1)
    const leased1 = await store.lease([
      {
        stream: stream1,
        by,
        at: at1,
        retry: 0,
        block: false,
      },
    ]);
    expect(leased1).toHaveLength(1);
    expect(leased1[0].stream).toBe(stream1);

    // Poll again: only stream2 should be available (since stream1 is leased)
    const poll2 = await store.poll(20);
    expect(poll2).toHaveLength(1); // Only stream2 should be available
    const at2 = poll2.find((s) => s.stream === stream2)!.at;

    // Lease stream2
    const leased2 = await store.lease([
      {
        stream: stream1,
        by,
        at: at1,
        retry: 0,
        block: false,
      },
      {
        stream: stream2,
        by,
        at: at2,
        retry: 0,
        block: false,
      },
    ]);
    expect(leased2).toHaveLength(1);
    expect(leased2[0].stream).toBe(stream2);

    // Ack both leases to mark all streams as processed
    await store.ack(leased2);
    await store.ack(leased1);

    // Final poll: no streams should be available
    const poll3 = await store.poll(20);
    expect(poll3).toHaveLength(0);
  });
});
