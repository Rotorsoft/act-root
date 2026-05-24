/**
 * SQLite discovery probe tests (ACT-1122).
 *
 * Fixtures: each test builds throwaway SQLite files in a tempdir using
 * the real `SqliteStore` (act-sqlite's `.seed()` creates the events +
 * streams tables) and points the probe at the directory. Cleanup runs
 * in `afterEach` so the tempdir doesn't linger between tests.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteStore } from "@rotorsoft/act-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverSqlite,
  probeSqliteFile,
} from "../../src/server/discovery/sqlite-probe.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "act-inspector-sqlite-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function buildActSqlite(file: string, withEvents = false): Promise<void> {
  const store = new SqliteStore({ url: `file:${file}` });
  try {
    await store.seed();
    if (withEvents) {
      await store.commit(
        "stream-a",
        [
          { name: "OpenedV1", data: { i: 1 } },
          { name: "OpenedV1", data: { i: 2 } },
        ],
        { correlation: "c", causation: {} }
      );
    }
  } finally {
    await store.dispose();
  }
}

describe("probeSqliteFile", () => {
  it("recognizes a freshly-seeded Act SQLite file", async () => {
    const file = path.join(dir, "store.db");
    await buildActSqlite(file);
    const result = await probeSqliteFile(file);
    expect(result).toEqual({
      kind: "sqlite",
      file,
      table: "events",
      eventCount: 0,
    });
  });

  it("counts events when the store has data", async () => {
    const file = path.join(dir, "store.db");
    await buildActSqlite(file, true);
    const result = await probeSqliteFile(file);
    expect(result?.eventCount).toBe(2);
  });

  it("returns null for a non-SQLite file (corrupt binary content)", async () => {
    const file = path.join(dir, "not-sqlite.db");
    await writeFile(file, Buffer.from("this is not a sqlite database"));
    const result = await probeSqliteFile(file);
    expect(result).toBeNull();
  });

  it("returns null for a SQLite file without the Act table shape", async () => {
    const file = path.join(dir, "other.db");
    // Build a SQLite database with a different schema — no events table.
    const { createClient } = await import("@libsql/client");
    const client = createClient({ url: `file:${file}` });
    try {
      await client.execute(
        "CREATE TABLE unrelated (id INTEGER PRIMARY KEY, payload TEXT)"
      );
    } finally {
      client.close();
    }
    const result = await probeSqliteFile(file);
    expect(result).toBeNull();
  });
});

describe("discoverSqlite", () => {
  it("returns [] when the directory does not exist", async () => {
    const result = await discoverSqlite({
      dir: path.join(dir, "does-not-exist"),
    });
    expect(result).toEqual([]);
  });

  it("returns [] when the directory has no matching files", async () => {
    await writeFile(path.join(dir, "readme.txt"), "hi");
    const result = await discoverSqlite({ dir });
    expect(result).toEqual([]);
  });

  it("finds every Act-shaped file by default glob", async () => {
    await buildActSqlite(path.join(dir, "first.db"));
    await buildActSqlite(path.join(dir, "second.sqlite"), true);
    await buildActSqlite(path.join(dir, "third.sqlite3"));
    const result = await discoverSqlite({ dir });
    expect(result).toHaveLength(3);
    expect(result.every((r) => r.kind === "sqlite")).toBe(true);
    const counts = Object.fromEntries(
      result.map((r) => [path.basename(r.file), r.eventCount])
    );
    expect(counts).toEqual({
      "first.db": 0,
      "second.sqlite": 2,
      "third.sqlite3": 0,
    });
  });

  it("respects a custom glob", async () => {
    await buildActSqlite(path.join(dir, "keep.act"));
    await buildActSqlite(path.join(dir, "skip.db"));
    const result = await discoverSqlite({ dir, glob: "\\.act$" });
    expect(result.map((r) => path.basename(r.file))).toEqual(["keep.act"]);
  });

  it("silently drops files that don't have the Act shape", async () => {
    await buildActSqlite(path.join(dir, "valid.db"));
    await writeFile(
      path.join(dir, "garbage.db"),
      Buffer.from("not a sqlite database")
    );
    const result = await discoverSqlite({ dir });
    expect(result).toHaveLength(1);
    expect(path.basename(result[0]!.file)).toBe("valid.db");
  });

  it("expands a leading `~/` to the operator's home directory", async () => {
    // Build an Act file in $HOME directly so a tilde-only path finds
    // it. We pick a marker filename unlikely to collide with anything
    // a developer keeps in their home dir, and clean up after.
    const { homedir } = await import("node:os");
    const marker = `act-inspector-tilde-test-${process.pid}-${Date.now()}.db`;
    const file = path.join(homedir(), marker);
    // Full regex-metachar escape — CodeQL's `js/incomplete-sanitization`
    // flags partial escapes (e.g. dots only), even when the input shape
    // makes other metacharacters impossible.
    const escapeForRegex = (s: string) =>
      s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      await buildActSqlite(file);
      const result = await discoverSqlite({
        dir: "~",
        glob: `^${escapeForRegex(marker)}$`,
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.file).toBe(file);
    } finally {
      await rm(file, { force: true });
    }
  });

  it("returns [] when given an invalid regex glob", async () => {
    await buildActSqlite(path.join(dir, "store.db"));
    // Unbalanced bracket — `new RegExp(...)` throws.
    const result = await discoverSqlite({ dir, glob: "[" });
    expect(result).toEqual([]);
  });
});
