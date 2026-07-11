import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { SqliteStore } from "../src/index.js";

// #1198: SQLite must revive payload ISO-date strings to `Date` for parity
// with PG/InMemory. Without a reviver, `JSON.parse` returns the raw ISO
// string and an InMemory→SQLite migration silently breaks reducers that
// call `.getTime()`.
const DB_PATH = join(import.meta.dirname, "date-roundtrip.db");

describe("sqlite Date round-trip parity (#1198)", () => {
  const store = new SqliteStore({ url: `file:${DB_PATH}` });

  beforeAll(async () => {
    await store.drop();
    await store.seed();
  });

  afterAll(async () => {
    await store.dispose();
    for (const ext of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(DB_PATH + ext);
      } catch {
        // file may not exist
      }
    }
  });

  it("returns a payload Date as a Date instance", async () => {
    const when = new Date("2026-07-11T12:34:56.000Z");
    await store.commit(
      "dr-stream",
      [{ name: "E", data: { when, label: "not-a-date" } }],
      { correlation: "", causation: {} }
    );
    const got: Array<{ when: unknown; label: unknown }> = [];
    await store.query<Record<string, never>>(
      (e) => got.push(e.data as { when: unknown; label: unknown }),
      { stream: "dr-stream", stream_exact: true }
    );
    expect(got).toHaveLength(1);
    expect(got[0].when).toBeInstanceOf(Date);
    expect((got[0].when as Date).getTime()).toBe(when.getTime());
    // A non-ISO string stays a string.
    expect(got[0].label).toBe("not-a-date");
  });
});
