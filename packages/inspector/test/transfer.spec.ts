/**
 * Cross-source / cross-target transfer endpoint tests (ACT-1128 + #788).
 *
 * Real adapters, no mocking — each test builds a fresh SQLite or
 * CSV file in a tempdir, seeds it via the framework's own port
 * primitives, and exercises the inspector's `transfer` tRPC
 * mutation end-to-end. Verifies the destructive write path, the
 * dry-run path, the "same store" rejection, and the missing-
 * capability rejection.
 */
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { CsvFile } from "@rotorsoft/act";
import { SqliteStore } from "@rotorsoft/act-sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Transfers write to a persistent target, so they're gated behind
// write-mode (#1194). Enable it before the router module reads the env
// at import time. The path guard (#1194) also rejects paths outside the
// inspector cwd, so `dir` is a temp folder created *under* cwd (not
// `os.tmpdir()`), and every transfer passes cwd-relative paths.
vi.hoisted(() => {
  process.env.ACT_INSPECTOR_WRITE = "1";
});

const { inspectorRouter } = await import("../src/server/router.js");

const caller = inspectorRouter.createCaller({});

// Absolute temp dir under cwd + the same dir expressed relative to cwd.
// Setup helpers use the absolute form; every `transfer` call passes the
// relative form so it survives the cwd path guard.
let dir: string;
let rel: (name: string) => string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), "act-inspector-transfer-"));
  rel = (name: string) => path.relative(process.cwd(), path.join(dir, name));
});

afterEach(async () => {
  await caller.disconnect();
  await rm(dir, { recursive: true, force: true });
});

/**
 * Build a SQLite file with `n` events on a single stream. Uses
 * `SqliteStore.commit` directly — bypasses the inspector entirely
 * so test setup is independent of the code under test.
 */
async function buildSqliteWithEvents(name: string, n: number): Promise<string> {
  const relPath = rel(name);
  const store = new SqliteStore({ url: `file:${path.join(dir, name)}` });
  try {
    await store.seed();
    for (let i = 0; i < n; i++)
      await store.commit("s1", [{ name: "Tick", data: { i } }], {
        correlation: "test",
        causation: {},
      });
  } finally {
    await store.dispose();
  }
  // Return the cwd-relative form — every `transfer` call passes this so
  // it survives the path guard (#1194).
  return relPath;
}

/**
 * Count events in a SQLite file by querying directly. Like the
 * setup helper, this stays adapter-native to keep the test
 * orthogonal to the inspector. Takes a cwd-relative path.
 */
async function countSqliteEvents(file: string): Promise<number> {
  const store = new SqliteStore({ url: `file:${path.resolve(file)}` });
  try {
    let n = 0;
    await store.query(() => {
      n++;
    });
    return n;
  } finally {
    await store.dispose();
  }
}

describe("transfer", () => {
  it("rejects when source and target refer to the same store", async () => {
    const file = await buildSqliteWithEvents("same.sqlite", 1);
    await expect(
      caller.transfer({
        source: { adapter: "sqlite", file, table: "events" },
        target: { adapter: "sqlite", file, table: "events" },
      })
    ).rejects.toThrow(/Refusing to self-overwrite|same store/i);
  });

  it("transfers events SQLite → CSV with verbatim counts and id renumber", async () => {
    const sourceFile = await buildSqliteWithEvents("source.sqlite", 3);
    const targetFile = rel("out.csv");
    const result = await caller.transfer({
      source: { adapter: "sqlite", file: sourceFile, table: "events" },
      target: { adapter: "csv", file: targetFile },
    });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(3);
    expect(result.result.kept).toBe(3);
    expect(result.result.duration_ms).toBeGreaterThanOrEqual(0);
    // Sink renumbers ids densely from 1.
    const back: Array<{ id: number }> = [];
    await new CsvFile({ path: path.resolve(targetFile) }).query((e) =>
      back.push({ id: e.id })
    );
    expect(back.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("transfers events CSV → SQLite via round-trip", async () => {
    // First produce a CSV file by transferring out from SQLite, then
    // transfer back into a fresh SQLite file and check the count.
    const srcSqlite = await buildSqliteWithEvents("src.sqlite", 5);
    const csv = rel("mid.csv");
    await caller.transfer({
      source: { adapter: "sqlite", file: srcSqlite, table: "events" },
      target: { adapter: "csv", file: csv },
    });

    const dstSqlite = rel("dst.sqlite");
    // Seed an empty target so it has the events table.
    const seed = new SqliteStore({ url: `file:${path.resolve(dstSqlite)}` });
    await seed.seed();
    await seed.dispose();

    const result = await caller.transfer({
      source: { adapter: "csv", file: csv },
      target: { adapter: "sqlite", file: dstSqlite, table: "events" },
    });
    expect(result.count).toBe(5);
    expect(await countSqliteEvents(dstSqlite)).toBe(5);
  });

  it("dry-run reports counts without touching the target", async () => {
    const srcFile = await buildSqliteWithEvents("dry-src.sqlite", 4);
    const targetFile = rel("untouched.csv");
    const result = await caller.transfer({
      source: { adapter: "sqlite", file: srcFile, table: "events" },
      target: { adapter: "csv", file: targetFile },
      dry_run: true,
    });
    expect(result.result.kept).toBe(4);
    // No file should have been written by the dry-run path.
    await expect(
      new CsvFile({ path: path.resolve(targetFile) }).query(() => {})
    ).rejects.toThrow();
  });

  it("propagates source-side errors through `Transfer failed:` wrapping", async () => {
    // Bogus file path on the source side — SQLite query throws on
    // open. The error message should include "Transfer failed:"
    // wrapping.
    await expect(
      caller.transfer({
        source: {
          adapter: "sqlite",
          file: rel("does-not-exist.sqlite"),
          table: "events",
        },
        target: { adapter: "csv", file: rel("irrelevant.csv") },
      })
    ).rejects.toThrow(/Transfer failed/);
  });
});
