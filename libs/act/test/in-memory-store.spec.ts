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

  it("reuses compiled regex across streams sharing the same source", async () => {
    const s = store();
    await s.commit("order-1", [{ name: "A", data: {} }], {
      correlation: "c",
      causation: {},
    });
    // Two subscribers with the same source pattern.
    await s.subscribe([
      { stream: "sub-1", source: "order-.*" },
      { stream: "sub-2", source: "order-.*" },
    ]);
    // Advance their watermarks so hasWork() does not short-circuit on at < 0.
    const first = await s.claim(2, 0, "actor", 10);
    await s.ack(first.map((l) => ({ ...l, at: 0 })));
    // Commit a fresh event so both streams have new work past their watermark.
    await s.commit("order-1", [{ name: "A", data: {} }], {
      correlation: "c",
      causation: {},
    });
    // Second claim — both streams compile the same source; the cache reuses the regex.
    const claimed = await s.claim(2, 0, "actor2", 10000);
    expect(claimed.length).toBe(2);
  });

  // ACT-1103 lane contract: every adapter is exercised by `runStoreTck`
  // (see `test/store-tck.spec.ts`). InMemoryStore has no adapter-only
  // lane concern — there's no schema migration to validate.
});
