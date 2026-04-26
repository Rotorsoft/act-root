import {
  Committed,
  ConcurrencyError,
  SNAP_EVENT,
  Schemas,
  dispose,
  sleep,
  store,
} from "@rotorsoft/act";
import { Chance } from "chance";
import { SqliteStore } from "../src/index.js";
import { actor, app } from "./app.js";

const chance = new Chance();
const a1 = chance.guid();
const a2 = chance.guid();
const a3 = chance.guid();
let created_before: Date;
let created_after: Date;

describe("sqlite store", () => {
  beforeAll(async () => {
    store(new SqliteStore({ url: "file:test-store.db" }));
    await store().drop();
    await store().seed();
  });

  afterAll(async () => {
    await dispose()();
    // Clean up test DB
    const fs = await import("fs");
    try {
      fs.unlinkSync("test-store.db");
    } catch {
      // file may not exist
    }
  });

  it("should commit and query", async () => {
    const query_correlation = chance.guid();

    await store().commit(a1, [{ name: "test1", data: { value: "1" } }], {
      correlation: "",
      causation: {
        action: { stream: a1, name: "", actor: { id: "pm", name: "" } },
      },
    });
    created_after = new Date();
    await sleep(200);

    await store().commit(a1, [{ name: "test1", data: { value: "2" } }], {
      correlation: query_correlation,
      causation: {},
    });
    await store().commit(a2, [{ name: "test2", data: { value: "3" } }], {
      correlation: "",
      causation: {
        action: { stream: a2, name: "", actor: { id: "pm", name: "" } },
      },
    });
    await store().commit(a3, [{ name: "test1", data: { value: "4" } }], {
      correlation: "",
      causation: {},
    });

    await sleep(200);
    created_before = new Date();

    // Query all events
    const events: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => events.push(e));
    expect(events.length).toBe(4);

    // Query by stream (exact)
    const streamEvents: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => streamEvents.push(e), {
      stream: a1,
      stream_exact: true,
    });
    expect(streamEvents.length).toBe(2);

    // Query by name filter
    const nameEvents: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => nameEvents.push(e), { names: ["test1"] });
    expect(nameEvents.length).toBe(3);

    // Query by time range
    const timeEvents: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => timeEvents.push(e), {
      created_after,
      created_before,
    });
    expect(timeEvents.length).toBe(3);

    // Query with limit
    const limitEvents: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => limitEvents.push(e), { limit: 2 });
    expect(limitEvents.length).toBe(2);

    // Query backward
    const backEvents: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => backEvents.push(e), { backward: true });
    expect(backEvents[0].id).toBeGreaterThan(backEvents[1].id);
  });

  it("should detect concurrency errors", async () => {
    await expect(
      store().commit(
        a1,
        [{ name: "test1", data: { value: "conflict" } }],
        { correlation: "", causation: {} },
        0 // wrong expected version
      )
    ).rejects.toThrow(ConcurrencyError);
  });

  it("should subscribe, claim, and ack", async () => {
    const { subscribed, watermark: _wm } = await store().subscribe([
      { stream: "sub-1", source: a1 },
      { stream: "sub-2", source: a2 },
    ]);
    expect(subscribed).toBe(2);

    // Claim streams with pending events
    const leases = await store().claim(10, 0, "worker-1", 30000);
    expect(leases.length).toBeGreaterThan(0);

    // Ack first lease
    const acked = await store().ack(leases.map((l) => ({ ...l, at: 999 })));
    expect(acked.length).toBe(leases.length);

    // After ack, no more events to claim
    const leases2 = await store().claim(10, 0, "worker-1", 30000);
    expect(leases2.length).toBe(0);
  });

  it("should block streams on error", async () => {
    await store().subscribe([{ stream: "block-test" }]);
    // Reset to make it claimable
    await store().reset(["block-test"]);

    const leases = await store().claim(10, 0, "worker-1", 30000);
    const blockTarget = leases.find((l) => l.stream === "block-test");
    if (blockTarget) {
      const blocked = await store().block([
        { ...blockTarget, error: "test error" },
      ]);
      expect(blocked.length).toBe(1);

      // Blocked streams should not be claimable
      await store().reset(["block-test"]); // reset clears blocked flag
    }
  });

  it("should reset streams", async () => {
    const count = await store().reset(["sub-1", "sub-2"]);
    expect(count).toBe(2);
  });

  it("should truncate streams", async () => {
    const stream = "truncate-test";
    await store().commit(stream, [{ name: "e1", data: {} }], {
      correlation: "",
      causation: {},
    });
    await store().commit(stream, [{ name: "e2", data: {} }], {
      correlation: "",
      causation: {},
    });

    const result = await store().truncate([
      { stream, snapshot: { count: 42 } },
    ]);
    const entry = result.get(stream);
    expect(entry?.deleted).toBe(2);
    expect(entry?.committed.name).toBe(SNAP_EVENT);

    // Verify only snapshot remains
    const events: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => events.push(e), {
      stream,
      stream_exact: true,
      with_snaps: true,
    });
    expect(events.length).toBe(1);
    expect(events[0].name).toBe(SNAP_EVENT);
  });

  it("should work with the act app", async () => {
    await app.do("increment", { stream: "c1", actor }, {});
    await app.do("increment", { stream: "c1", actor }, {});
    await app.do("decrement", { stream: "c1", actor }, {});

    // Query events for the stream to verify
    const events: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => events.push(e), {
      stream: "c1",
      stream_exact: true,
    });
    expect(events.length).toBe(3);
    expect(events.filter((e) => e.name === "incremented").length).toBe(2);
    expect(events.filter((e) => e.name === "decremented").length).toBe(1);
  });
});
