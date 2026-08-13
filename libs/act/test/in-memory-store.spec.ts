import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { dispose, store } from "../src/index.js";

// Contract-level cases live in `in-memory-store-tck.spec.ts` (via the
// shared Store TCK in `@rotorsoft/act-tck`). This file only covers
// InMemory-specific implementation details that aren't part of the
// contract — adapter optimizations and edge cases.

describe("InMemoryStore (adapter-specific)", () => {
  beforeEach(async () => {
    store(new InMemoryStore());
    await store().seed();
  });

  afterEach(async () => {
    await store().drop();
    await dispose()();
  });

  it("claims by exact source and ignores sources with no committed events", async () => {
    const s = store();
    await s.commit("order-1", [{ name: "A", data: {} }], {
      correlation: "c",
      causation: {},
    });
    // One subscriber on an exact source with events, one on a source
    // that never receives a commit.
    await s.subscribe([
      { stream: "sub-1", source: "order-1" },
      { stream: "sub-2", source: "ghost" },
    ]);
    // Advance their watermarks so hasWork() does not short-circuit on at < 0.
    const first = await s.claim(2, 0, "actor", 10);
    await s.ack(first.map((l) => ({ ...l, at: 0 })));
    // Commit a fresh event so only the exact source has work past the watermark.
    await s.commit("order-1", [{ name: "A", data: {} }], {
      correlation: "c",
      causation: {},
    });
    const claimed = await s.claim(2, 0, "actor2", 10000);
    expect(claimed.map((l) => l.stream)).toEqual(["sub-1"]);
  });

  it("binary-searches id bounds on backward scans across truncation holes", async () => {
    const s = store();
    const meta = { correlation: "c", causation: {} };
    await s.commit("bw-a", [{ name: "A", data: {} }], meta); // id 0
    await s.commit("bw-b", [{ name: "B", data: {} }], meta); // id 1
    await s.commit("bw-a", [{ name: "A", data: {} }], meta); // id 2
    await s.commit("bw-b", [{ name: "B", data: {} }], meta); // id 3
    // Full truncate of bw-a punches holes at ids 0 and 2 — ids no longer
    // equal array indexes, so the backward `before` bound must resolve by
    // id, not position.
    await s.truncate([{ stream: "bw-a" }]);
    const ids: number[] = [];
    await s.query((e) => ids.push(e.id), { backward: true, before: 3 });
    expect(ids).toEqual([1]);
    // And without `before`: newest-first over the surviving ids.
    const all: number[] = [];
    await s.query((e) => all.push(e.id), { backward: true });
    expect(all[0]).toBeGreaterThan(3); // the truncate's tombstone seed
  });

  // ACT-1103 lane contract: every adapter is exercised by `runStoreTck`
  // (see `test/store-tck.spec.ts`). InMemoryStore has no adapter-only
  // lane concern — there's no schema migration to validate.

  // #1446, adapter-specific because this store is the only one whose ids
  // start at 0 — Postgres and SQLite both start at 1, which masked the
  // same window. While `claim` short-circuited a fresh `at = -1`
  // subscription into "claimable", an event committed between a cycle's
  // fetch and its ack was acked past: drain's empty-fetch watermark seeds
  // at 0, so acking a fresh stream to 0 stepped over event id 0 and the
  // very first event this store ever issued was never delivered.
  it("does not lose event id 0 when a commit lands during a fresh stream's cycle", async () => {
    const s = store();
    await s.subscribe([{ stream: "sub", source: "src" }]);

    // Nothing committed yet, so there is nothing to claim.
    expect(await s.claim(5, 5, "w", 5_000)).toHaveLength(0);

    // The first event this store ever issues carries id 0.
    const [first] = await s.commit("src", [{ name: "E", data: {} }], {
      correlation: "",
      causation: {},
    });
    expect(first.id).toBe(0);

    // It must be claimable, and the lease must open at -1 so the event
    // sits inside the fetch window rather than behind it.
    const leases = await s.claim(5, 5, "w", 5_000);
    expect(leases).toHaveLength(1);
    expect(leases[0].at).toBe(-1);
  });
});
