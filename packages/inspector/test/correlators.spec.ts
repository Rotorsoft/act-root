import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { readCorrelators } from "../src/server/correlators.js";

/**
 * Reading who is looking for work (#1539).
 *
 * This reads the framework's own table directly, because that table is not on
 * the `Store` interface — the same approach the connection probes take.
 */
describe("readCorrelators", () => {
  const db = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "act-correlators-"));
    return path.join(dir, "store.db");
  };

  it("reads each correlator's position and who holds it", async () => {
    const file = await db();
    const client = createClient({ url: `file:${file}` });
    await client.execute(
      "CREATE TABLE correlated (key TEXT PRIMARY KEY, at INTEGER NOT NULL DEFAULT -1, leased_by TEXT, leased_until INTEGER)"
    );
    await client.execute("INSERT INTO correlated (key, at) VALUES ('', 40)");
    await client.execute(
      "INSERT INTO correlated (key, at, leased_by, leased_until) VALUES ('abc', 42, 'worker-1', 1700000000000)"
    );
    client.close();

    const rows = await readCorrelators({ adapter: "sqlite", file });
    expect(rows).toEqual([
      { key: "", at: 40, leasedBy: null, leasedUntil: null },
      {
        key: "abc",
        at: 42,
        leasedBy: "worker-1",
        leasedUntil: 1700000000000,
      },
    ]);
  });

  it("returns nothing rather than throwing when there is no such table", async () => {
    // An in-memory store keeps this in memory, and a store predating the
    // change has an older shape. Neither is worth interrupting the page for.
    const file = await db();
    const client = createClient({ url: `file:${file}` });
    await client.execute("CREATE TABLE unrelated (x INTEGER)");
    client.close();

    expect(await readCorrelators({ adapter: "sqlite", file })).toEqual([]);
  });

  it("returns nothing rather than throwing when the server is unreachable", async () => {
    expect(
      await readCorrelators({
        adapter: "pg",
        host: "127.0.0.1",
        // Nothing listens here; the read must degrade, not take the page down.
        port: 59_999,
        database: "postgres",
        user: "postgres",
        password: "postgres",
        schema: "public",
        table: "events",
      })
    ).toEqual([]);
  });
});
