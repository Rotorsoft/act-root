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

  it("should query with no params", async () => {
    const count = await store().query(() => {});
    expect(count).toBeGreaterThan(0);
  });

  it("should query with non-exact stream pattern (LIKE)", async () => {
    await store().commit("regex-A", [{ name: "rt", data: {} }], {
      correlation: "",
      causation: {},
    });
    await store().commit("regex-B", [{ name: "rt", data: {} }], {
      correlation: "",
      causation: {},
    });
    const result: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => result.push(e), { stream: "regex-.*" });
    expect(result.length).toBe(2);
    // single-char wildcard via "."
    const result2: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => result2.push(e), { stream: "regex-." });
    expect(result2.length).toBe(2);
  });

  it("should query with anchored stream patterns", async () => {
    await store().commit("anchor-prefix-1", [{ name: "ap", data: {} }], {
      correlation: "",
      causation: {},
    });
    await store().commit("anchor-prefix-2", [{ name: "ap", data: {} }], {
      correlation: "",
      causation: {},
    });
    await store().commit("tail-anchor-suffix", [{ name: "ap", data: {} }], {
      correlation: "",
      causation: {},
    });

    // ^prefix.* — starts-with
    const startsWith: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => startsWith.push(e), {
      stream: "^anchor-prefix.*",
    });
    expect(startsWith.length).toBe(2);
    expect(startsWith.every((e) => e.stream.startsWith("anchor-prefix"))).toBe(
      true
    );

    // .*suffix$ — ends-with
    const endsWith: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => endsWith.push(e), { stream: ".*suffix$" });
    expect(endsWith.length).toBe(1);
    expect(endsWith[0].stream).toBe("tail-anchor-suffix");

    // ^exact$ — exact via regex anchors (without stream_exact)
    const exact: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => exact.push(e), {
      stream: "^anchor-prefix-1$",
    });
    expect(exact.length).toBe(1);
    expect(exact[0].stream).toBe("anchor-prefix-1");
  });

  it("should claim with regex source patterns (anchored + wildcard)", async () => {
    await store().commit("src-pat-alpha", [{ name: "sp", data: {} }], {
      correlation: "",
      causation: {},
    });
    await store().commit("src-pat-beta", [{ name: "sp", data: {} }], {
      correlation: "",
      causation: {},
    });
    await store().subscribe([
      { stream: "src-listener", source: "^src-pat-.*" },
    ]);

    const leases = await store().claim(10, 0, "src-worker", 30000);
    const target = leases.find((l) => l.stream === "src-listener");
    expect(target).toBeDefined();
    expect(target!.source).toBe("^src-pat-.*");
    if (leases.length) await store().ack(leases.map((l) => ({ ...l, at: 0 })));
  });

  it("should not claim when source pattern matches no events", async () => {
    await store().subscribe([
      { stream: "src-no-match", source: "^never-matches-anything-.*" },
    ]);
    const leases = await store().claim(10, 0, "ghost-worker", 30000);
    expect(leases.find((l) => l.stream === "src-no-match")).toBeUndefined();
    if (leases.length) await store().ack(leases.map((l) => ({ ...l, at: 0 })));
  });

  it("should query by correlation", async () => {
    const correlation = chance.guid();
    await store().commit("corr-test", [{ name: "ct", data: {} }], {
      correlation,
      causation: {},
    });
    const result: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => result.push(e), { correlation });
    expect(result.length).toBe(1);
  });

  it("should query with before id", async () => {
    const all: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => all.push(e));
    const cutoff = all[2].id;
    const result: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => result.push(e), { before: cutoff });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((e) => e.id < cutoff)).toBe(true);
  });

  it("should query with after id", async () => {
    const result: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => result.push(e), { after: 1, limit: 3 });
    expect(result.length).toBe(3);
    expect(result.every((e) => e.id > 1)).toBe(true);
  });

  it("should commit empty events array", async () => {
    const result = await store().commit("empty-test", [], {
      correlation: "",
      causation: {},
    });
    expect(result).toEqual([]);
  });

  it("should re-subscribing existing stream returns 0", async () => {
    await store().subscribe([{ stream: "resub-test" }]);
    const { subscribed } = await store().subscribe([{ stream: "resub-test" }]);
    expect(subscribed).toBe(0);
  });

  it("should reset empty array", async () => {
    const count = await store().reset([]);
    expect(count).toBe(0);
  });

  it("should reset non-existent streams returns 0", async () => {
    const count = await store().reset(["does-not-exist-xyz"]);
    expect(count).toBe(0);
  });

  it("should truncate with tombstone (no snapshot)", async () => {
    const stream = "tombstone-test";
    await store().commit(stream, [{ name: "e1", data: {} }], {
      correlation: "",
      causation: {},
    });
    const result = await store().truncate([{ stream }]);
    expect(result.get(stream)?.deleted).toBe(1);
    expect(result.get(stream)?.committed.name).toBe("__tombstone__");
  });

  it("should truncate with custom meta", async () => {
    const stream = "trunc-meta";
    await store().commit(stream, [{ name: "e", data: {} }], {
      correlation: "",
      causation: {},
    });
    const meta = {
      correlation: "X",
      causation: {
        action: { stream, name: "n", actor: { id: "1", name: "u" } },
      },
    };
    const result = await store().truncate([{ stream, meta }]);
    expect(result.get(stream)?.committed.meta.correlation).toBe("X");
  });

  it("should claim with leading frontier (dual frontiers)", async () => {
    await store().subscribe([{ stream: "lead-test" }]);
    await store().commit(
      "lead-test",
      [
        { name: "x", data: {} },
        { name: "x", data: {} },
      ],
      { correlation: "", causation: {} }
    );
    const claimed = await store().claim(0, 10, "leader-1", 30000);
    expect(claimed.length).toBeGreaterThan(0);
    if (claimed.length)
      await store().ack(claimed.map((l) => ({ ...l, at: 0 })));
  });

  it("should not claim blocked streams", async () => {
    await store().subscribe([{ stream: "blocked-not-claimed" }]);
    await store().commit("blocked-not-claimed", [{ name: "z", data: {} }], {
      correlation: "",
      causation: {},
    });
    const claimed = await store().claim(100, 0, "w-block", 30000);
    const target = claimed.find((l) => l.stream === "blocked-not-claimed");
    expect(target).toBeDefined();
    const others = claimed.filter((l) => l.stream !== "blocked-not-claimed");
    if (others.length) await store().ack(others);
    await store().block([{ ...target!, error: "boom" }]);

    const claimed2 = await store().claim(100, 100, "w-block-2", 30000);
    expect(
      claimed2.find((l) => l.stream === "blocked-not-claimed")
    ).toBeUndefined();
    if (claimed2.length) await store().ack(claimed2);
    await store().reset(["blocked-not-claimed"]);
  });

  it("should not block a stream leased by a different drainer", async () => {
    await store().subscribe([{ stream: "block-wrong-drainer" }]);
    await store().commit("block-wrong-drainer", [{ name: "z", data: {} }], {
      correlation: "",
      causation: {},
    });
    const claimed = await store().claim(100, 0, "actor-1", 100000);
    const target = claimed.find((l) => l.stream === "block-wrong-drainer");
    expect(target).toBeDefined();
    const others = claimed.filter((l) => l.stream !== "block-wrong-drainer");
    if (others.length) await store().ack(others);

    const blocked = await store().block([
      { ...target!, by: "actor-2", error: "wrong drainer" },
    ]);
    expect(blocked.length).toBe(0);
  });

  it("should not ack a lease owned by a different drainer", async () => {
    await store().subscribe([{ stream: "ack-wrong-drainer" }]);
    await store().commit("ack-wrong-drainer", [{ name: "z", data: {} }], {
      correlation: "",
      causation: {},
    });
    const claimed = await store().claim(100, 0, "owner-1", 100000);
    const target = claimed.find((l) => l.stream === "ack-wrong-drainer");
    expect(target).toBeDefined();
    const others = claimed.filter((l) => l.stream !== "ack-wrong-drainer");
    if (others.length) await store().ack(others);

    const acked = await store().ack([{ ...target!, by: "owner-2", at: 99 }]);
    expect(acked.length).toBe(0);
  });

  it("should query_streams with filters and pagination", async () => {
    await store().subscribe([
      { stream: "qs-projection-tickets" },
      { stream: "qs-projection-users" },
      { stream: "qs-stats-user-1", source: "qs-source-1" },
      { stream: "qs-stats-user-2", source: "qs-source-2" },
    ]);

    // No filter for the qs- prefix returns all four
    const all: any[] = [];
    const result = await store().query_streams((p) => all.push(p), {
      stream: "^qs-",
    });
    expect(result.count).toBe(4);
    expect(result.maxEventId).toBeGreaterThanOrEqual(0);
    expect(all.map((p) => p.stream)).toEqual([
      "qs-projection-tickets",
      "qs-projection-users",
      "qs-stats-user-1",
      "qs-stats-user-2",
    ]);

    // stream regex (LIKE under the hood)
    const projections: any[] = [];
    await store().query_streams((p) => projections.push(p), {
      stream: "^qs-projection-",
    });
    expect(projections).toHaveLength(2);

    // stream_exact
    const exact: any[] = [];
    await store().query_streams((p) => exact.push(p), {
      stream: "qs-stats-user-1",
      stream_exact: true,
    });
    expect(exact).toHaveLength(1);
    expect(exact[0].source).toBe("qs-source-1");

    // source filter — only rows with source set
    const dynamics: any[] = [];
    await store().query_streams((p) => dynamics.push(p), {
      stream: "^qs-",
      source: "^qs-source-",
    });
    expect(dynamics).toHaveLength(2);
    expect(dynamics.every((p) => p.source !== undefined)).toBe(true);

    // source_exact filter
    const exactSource: any[] = [];
    await store().query_streams((p) => exactSource.push(p), {
      stream: "^qs-",
      source: "qs-source-2",
      source_exact: true,
    });
    expect(exactSource).toHaveLength(1);
    expect(exactSource[0].stream).toBe("qs-stats-user-2");

    // limit + after pagination
    const page1: any[] = [];
    await store().query_streams((p) => page1.push(p), {
      stream: "^qs-",
      limit: 2,
    });
    expect(page1.map((p) => p.stream)).toEqual([
      "qs-projection-tickets",
      "qs-projection-users",
    ]);
    const page2: any[] = [];
    await store().query_streams((p) => page2.push(p), {
      stream: "^qs-",
      limit: 2,
      after: page1.at(-1)!.stream,
    });
    expect(page2.map((p) => p.stream)).toEqual([
      "qs-stats-user-1",
      "qs-stats-user-2",
    ]);

    // blocked filter — use a non-source projection so claim's source-stream
    // filter doesn't exclude it
    await store().commit("qs-projection-tickets", [{ name: "z", data: {} }], {
      correlation: "",
      causation: {},
    });
    const claimed = await store().claim(100, 0, "qs-worker", 100000);
    const target = claimed.find((l) => l.stream === "qs-projection-tickets");
    expect(target).toBeDefined();
    const others = claimed.filter((l) => l.stream !== "qs-projection-tickets");
    if (others.length) await store().ack(others);
    await store().block([{ ...target!, error: "boom" }]);

    const blocked: any[] = [];
    await store().query_streams((p) => blocked.push(p), {
      stream: "^qs-",
      blocked: true,
    });
    expect(blocked).toHaveLength(1);
    expect(blocked[0].stream).toBe("qs-projection-tickets");
    expect(blocked[0].error).toBe("boom");

    // blocked: false (excludes the blocked stream)
    const unblocked: any[] = [];
    await store().query_streams((p) => unblocked.push(p), {
      stream: "^qs-",
      blocked: false,
    });
    expect(unblocked).toHaveLength(3);
    expect(
      unblocked.find((p) => p.stream === "qs-projection-tickets")
    ).toBeUndefined();

    // No query at all — exercises undefined-query branches
    const noQuery: any[] = [];
    const noQueryResult = await store().query_streams((p) => noQuery.push(p));
    expect(noQueryResult.count).toBeGreaterThan(0);
    expect(noQueryResult.maxEventId).toBeGreaterThanOrEqual(0);
  });
});
