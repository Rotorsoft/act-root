import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/index.js";
import { walk_streams } from "../src/internal/index.js";

/**
 * `Store.query_streams` defaults to `limit: 100`, so any caller wanting
 * the whole table has to page. `walk_streams` is that loop (#1371).
 */
describe("walk_streams", () => {
  const seed = async (count: number) => {
    const store = new InMemoryStore();
    await store.seed();
    await store.subscribe(
      Array.from({ length: count }, (_, i) => ({
        stream: `s-${String(i).padStart(3, "0")}`,
      }))
    );
    return store;
  };

  it("visits every stream across multiple pages", async () => {
    const store = await seed(5);
    const seen: string[] = [];
    // Page size 2 over 5 streams — three pages, the last one short.
    const total = await walk_streams(store, (p) => seen.push(p.stream), {
      limit: 2,
    });

    expect(total).toBe(5);
    expect(seen).toEqual(["s-000", "s-001", "s-002", "s-003", "s-004"]);
    await store.dispose();
  });

  it("stops on an exact-multiple final page without re-emitting", async () => {
    const store = await seed(4);
    const seen: string[] = [];
    // 4 streams at page size 2 — the second page is full, so the walk
    // takes a third (empty) page to learn it is done.
    const total = await walk_streams(store, (p) => seen.push(p.stream), {
      limit: 2,
    });

    expect(total).toBe(4);
    expect(new Set(seen).size).toBe(4);
    await store.dispose();
  });

  it("defaults the page size and honors a seeded cursor", async () => {
    const store = await seed(3);
    const all: string[] = [];
    await walk_streams(store, (p) => all.push(p.stream));
    expect(all).toHaveLength(3);

    const after: string[] = [];
    await walk_streams(store, (p) => after.push(p.stream), {
      after: "s-000",
    });
    expect(after).toEqual(["s-001", "s-002"]);
    await store.dispose();
  });
});
