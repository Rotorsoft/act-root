/**
 * `query`, `stats`, `eventNames`, `backup` (ACT-1131).
 *
 * Shared fixture: three streams with a mix of event names + one row
 * carrying CSV-hostile characters (commas, quotes, newlines) so the
 * backup escaper has something to chew on. The fixture seeds events
 * directly into the active `InMemoryStore` after connecting through
 * the public router — no mocking.
 */
import type { InMemoryStore } from "@rotorsoft/act";
import { beforeEach, describe, expect, it } from "vitest";
import { getActiveStore, inspectorRouter } from "../src/server/router.js";
import { seed, seedSequence } from "./helpers.js";

const caller = inspectorRouter.createCaller({});

let store: InMemoryStore;

beforeEach(async () => {
  await caller.disconnect();
  await caller.connect({ adapter: "inmemory" });
  store = getActiveStore() as InMemoryStore;
});

async function seedAll() {
  await seedSequence(store, "stream-a", [
    { name: "OpenedV1", data: { tag: "alpha" } },
    { name: "ClosedV1" },
  ]);
  await seedSequence(store, "stream-b", [{ name: "OpenedV1" }]);
  // Hostile data on stream-c — exercises csvEscape() across all three
  // branches (comma, double-quote, newline).
  await seed(store, "stream-c", "Tricky", {
    csv: 'has,"quotes" and\nnewlines',
  });
}

describe("query", () => {
  it("returns all events with default limit", async () => {
    await seedAll();
    const result = await caller.query({});
    expect(result.events).toHaveLength(4);
  });

  it("filters by stream", async () => {
    await seedAll();
    const result = await caller.query({ stream: "stream-a" });
    expect(result.events.map((e) => e.stream)).toEqual([
      "stream-a",
      "stream-a",
    ]);
  });

  it("filters by name", async () => {
    await seedAll();
    const result = await caller.query({ names: ["OpenedV1"] });
    expect(result.events.every((e) => e.name === "OpenedV1")).toBe(true);
    expect(result.events).toHaveLength(2);
  });

  it("honors `limit`", async () => {
    await seedAll();
    const result = await caller.query({ limit: 1 });
    expect(result.events).toHaveLength(1);
  });

  it("filters by id range with `after`/`before`", async () => {
    await seedAll();
    const result = await caller.query({ after: 1, before: 4 });
    expect(result.events.map((e) => e.id)).toEqual([2, 3]);
  });

  it("converts `created_before`/`created_after` ISO strings to Date filters", async () => {
    await seedAll();
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(0).toISOString();
    const after = await caller.query({ created_after: past });
    const before = await caller.query({ created_before: future });
    expect(after.events.length).toBeGreaterThan(0);
    expect(before.events.length).toBeGreaterThan(0);
    const none = await caller.query({ created_before: past });
    expect(none.events).toHaveLength(0);
  });

  it("supports backward + correlation passthrough", async () => {
    await seedAll();
    // InMemoryStore assigns ids from `_events.length` — first commit
    // gets id 0, so the four-event fixture lands at [0, 1, 2, 3].
    const backward = await caller.query({ backward: true, limit: 2 });
    expect(backward.events.map((e) => e.id)).toEqual([3, 2]);
    const matched = await caller.query({ correlation: "test-correlation" });
    expect(matched.events.length).toBe(4);
    const nope = await caller.query({ correlation: "no-such-id" });
    expect(nope.events).toHaveLength(0);
  });
});

describe("stats", () => {
  it("aggregates totals and timeSpan", async () => {
    await seedAll();
    const result = await caller.stats({});
    expect(result.totalEvents).toBe(4);
    expect(result.uniqueStreams).toBe(3);
    expect(result.uniqueEventNames).toBe(3);
    expect(result.timeSpan).not.toBeNull();
    expect(new Date(result.timeSpan!.from).getTime()).toBeLessThanOrEqual(
      new Date(result.timeSpan!.to).getTime()
    );
  });

  it("returns null timeSpan on an empty store", async () => {
    const result = await caller.stats({});
    expect(result).toEqual({
      totalEvents: 0,
      uniqueStreams: 0,
      uniqueEventNames: 0,
      timeSpan: null,
    });
  });

  it("respects filter inputs", async () => {
    await seedAll();
    const filtered = await caller.stats({
      stream: "stream-a",
      names: ["OpenedV1"],
      correlation: "test-correlation",
      created_after: new Date(0).toISOString(),
    });
    expect(filtered.totalEvents).toBe(1);
    expect(filtered.uniqueStreams).toBe(1);
  });
});

describe("eventNames", () => {
  it("returns sorted distinct names", async () => {
    await seedAll();
    const names = await caller.eventNames();
    expect(names).toEqual(["ClosedV1", "OpenedV1", "Tricky"]);
  });

  it("returns [] on an empty store", async () => {
    expect(await caller.eventNames()).toEqual([]);
  });
});

describe("backup", () => {
  it("emits a header even when no rows match", async () => {
    const result = await caller.backup({});
    expect(result.count).toBe(0);
    expect(result.csv).toBe("id,name,data,stream,version,created,meta");
  });

  it("escapes commas, quotes, and newlines per RFC 4180", async () => {
    await seedAll();
    const result = await caller.backup({ stream: "stream-c" });
    expect(result.count).toBe(1);
    // The data column was JSON.stringify'd then CSV-doubled. JSON
    // escapes the inner `"` to `\"`, then CSV doubles every `"` —
    // producing `\""quotes\""` around the literal "quotes" identifier.
    expect(result.csv).toContain('\\""quotes\\""');
    // The literal `,` inside the data forced csvEscape to wrap the
    // whole column in quotes; the comma itself survives untouched.
    expect(result.csv).toContain("has,");
    // The actual newline character in the source string was JSON-
    // escaped to the two-char sequence `\n`, which the CSV layer
    // leaves alone.
    expect(result.csv).toContain("\\n");
  });

  it("respects filter inputs", async () => {
    await seedAll();
    const result = await caller.backup({
      names: ["Tricky"],
      created_after: new Date(0).toISOString(),
    });
    expect(result.count).toBe(1);
  });
});
