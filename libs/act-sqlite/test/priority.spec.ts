/**
 * ACT-102 — `SqliteStore` priority lanes integration tests against
 * a file-backed libSQL database (`file::memory:` doesn't share state
 * across libSQL transactions in this client version, so we use a
 * scratch file under `/tmp` and clean it up between tests).
 *
 * Bypasses the `store()` singleton port — these tests construct a
 * fresh `SqliteStore` per test so cross-test state and
 * port-singleton lifetime stay out of scope.
 */

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { SqliteStore } from "../src/sqlite-store.js";

let s: SqliteStore;
let dbPath: string;
const store = () => s;

describe("SqliteStore priority lanes", () => {
  beforeEach(async () => {
    dbPath = `/tmp/act-priority-${randomUUID()}.db`;
    s = new SqliteStore({ url: `file:${dbPath}` });
    await s.seed();
  });

  afterEach(async () => {
    await s.dispose();
    try {
      unlinkSync(dbPath);
    } catch {
      // file may not exist
    }
  });

  it("subscribe keeps the max priority across reactions", async () => {
    await store().subscribe([{ stream: "shared", priority: 3 }]);
    await store().subscribe([{ stream: "shared", priority: 1 }]); // ignored
    await store().subscribe([{ stream: "shared", priority: 9 }]); // wins

    const positions: any[] = [];
    await store().query_streams((p) => positions.push(p), { stream: "shared" });
    expect(positions[0].priority).toBe(9);
  });

  it("claim returns higher-priority streams first under tied watermarks", async () => {
    const meta = { correlation: "", causation: {} };
    await store().commit("src", [{ name: "X", data: {} }], meta);
    await store().commit("src", [{ name: "Y", data: {} }], meta);

    await store().subscribe([
      { stream: "low", source: "src", priority: 0 },
      { stream: "high", source: "src", priority: 5 },
    ]);

    const leases = await store().claim(1, 0, randomUUID(), 5_000);
    expect(leases.map((l) => l.stream)).toEqual(["high"]);
  });

  it("prioritize updates by exact stream match", async () => {
    await store().subscribe([{ stream: "a" }, { stream: "b" }]);
    const updated = await store().prioritize(
      { stream: "b", stream_exact: true },
      7
    );
    expect(updated).toBe(1);

    const seen: any[] = [];
    await store().query_streams((p) => seen.push(p));
    const byStream = Object.fromEntries(
      seen.map((p) => [p.stream, p.priority])
    );
    expect(byStream).toEqual({ a: 0, b: 7 });
  });

  it("prioritize matches by stream LIKE pattern", async () => {
    await store().subscribe([
      { stream: "proj-a" },
      { stream: "proj-b" },
      { stream: "audit-x" },
    ]);
    // SQLite uses LIKE-translated patterns — `^proj-.*$` becomes
    // `proj-%`, which matches both proj rows.
    const updated = await store().prioritize({ stream: "^proj-.*$" }, 3);
    expect(updated).toBe(2);
  });

  it("prioritize matches by source filter", async () => {
    await store().subscribe([
      { stream: "t1", source: "users" },
      { stream: "t2", source: "audit" },
    ]);
    const updated = await store().prioritize(
      { source: "users", source_exact: true },
      4
    );
    expect(updated).toBe(1);
  });

  it("prioritize source filter ignores rows without source", async () => {
    await store().subscribe([
      { stream: "no-source" },
      { stream: "with-source", source: "x" },
    ]);
    const updated = await store().prioritize({ source: "x" }, 2);
    expect(updated).toBe(1);
  });

  it("prioritize empty filter updates all rows", async () => {
    await store().subscribe([{ stream: "a" }, { stream: "b" }]);
    const updated = await store().prioritize({}, 5);
    expect(updated).toBe(2);
  });

  it("prioritize is a no-op when value matches existing", async () => {
    await store().subscribe([{ stream: "a", priority: 5 }]);
    const updated = await store().prioritize({}, 5);
    expect(updated).toBe(0);
  });

  it("prioritize matches by blocked state (blocked=true)", async () => {
    const meta = { correlation: "", causation: {} };
    await store().commit("src", [{ name: "X", data: {} }], meta);
    await store().subscribe([
      { stream: "ok", source: "src" },
      { stream: "bad", source: "src" },
    ]);
    const leases = await store().claim(2, 0, randomUUID(), 5_000);
    const badLease = leases.find((l) => l.stream === "bad")!;
    await store().block([{ ...badLease, error: "boom" }]);

    const updated = await store().prioritize({ blocked: true }, 9);
    expect(updated).toBe(1);
  });

  it("prioritize matches by blocked state (blocked=false)", async () => {
    // Same set-up — but `blocked: false` should match the *unblocked*
    // streams. Confirms both arms of the ternary translate to 0/1.
    const meta = { correlation: "", causation: {} };
    await store().commit("src", [{ name: "X", data: {} }], meta);
    await store().subscribe([
      { stream: "ok", source: "src" },
      { stream: "bad", source: "src" },
    ]);
    const leases = await store().claim(2, 0, randomUUID(), 5_000);
    const badLease = leases.find((l) => l.stream === "bad")!;
    await store().block([{ ...badLease, error: "boom" }]);

    const updated = await store().prioritize({ blocked: false }, 9);
    expect(updated).toBe(1); // only the unblocked one
  });

  it("query_streams emits priority in StreamPosition", async () => {
    await store().subscribe([{ stream: "x", priority: 4 }]);
    const seen: any[] = [];
    await store().query_streams((p) => seen.push(p), { stream: "x" });
    expect(seen[0].priority).toBe(4);
  });

  it("seed migration is idempotent — running seed twice doesn't error", async () => {
    // Migration uses ALTER TABLE ADD COLUMN inside a try/catch so
    // re-seeding a fresh-schema DB shouldn't throw on the duplicate
    // column.
    await expect(store().seed()).resolves.toBeUndefined();
  });
});
