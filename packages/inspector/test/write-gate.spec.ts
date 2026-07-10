/**
 * Write-mode gate on `transfer` (#1194) + the CORS mutation guard
 * (#1195), exercised with write-mode OFF — the default read-only
 * inspector. Separate file from security.spec.ts because `writeEnabled`
 * is captured from the env at module import, so a file can only be one
 * or the other. This file leaves ACT_INSPECTOR_WRITE unset.
 */
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { SqliteStore } from "@rotorsoft/act-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectorRouter } from "../src/server/router.js";

const caller = inspectorRouter.createCaller({});

let dir: string;
let rel: (name: string) => string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), "act-inspector-writegate-"));
  rel = (name) => path.relative(process.cwd(), path.join(dir, name));
});

afterEach(async () => {
  await caller.disconnect();
  await rm(dir, { recursive: true, force: true });
});

async function buildRelativeSqlite(name: string, n: number): Promise<string> {
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
  return relPath;
}

describe("#1194 write-mode gate — transfer refused when read-only", () => {
  it("refuses an in-cwd transfer that writes to a persistent target", async () => {
    const src = await buildRelativeSqlite("wg-src.sqlite", 2);
    await expect(
      caller.transfer({
        source: { adapter: "sqlite", file: src, table: "events" },
        target: { adapter: "csv", file: rel("wg-out.csv") },
      })
    ).rejects.toThrow(/read-only mode/i);
  });

  it("allows a read-only dry-run transfer even when write-mode is off", async () => {
    const src = await buildRelativeSqlite("wg-dry.sqlite", 3);
    const result = await caller.transfer({
      source: { adapter: "sqlite", file: src, table: "events" },
      target: { adapter: "csv", file: rel("wg-dry-out.csv") },
      dry_run: true,
    });
    expect(result.result.kept).toBe(3);
  });

  it("allows a download (read-only export) transfer when write-mode is off", async () => {
    const src = await buildRelativeSqlite("wg-dl.sqlite", 4);
    const result = await caller.transfer({
      source: { adapter: "sqlite", file: src, table: "events" },
      target: { adapter: "download" },
    });
    expect(result.count).toBe(4);
    expect(result.csv).toContain("Tick");
  });
});

describe("#1195 mutation origin guard", () => {
  it("refuses an origin-less HTTP mutation (viaHttp, no allowlist)", async () => {
    const httpCaller = inspectorRouter.createCaller({ viaHttp: true });
    await expect(httpCaller.connect({ adapter: "inmemory" })).rejects.toThrow(
      /cross-site mutation rejected/i
    );
  });

  it("allows a localhost-origin HTTP mutation", async () => {
    const httpCaller = inspectorRouter.createCaller({
      viaHttp: true,
      origin: "http://localhost:5173",
    });
    const res = await httpCaller.connect({ adapter: "inmemory" });
    expect(res.ok).toBe(true);
    await httpCaller.disconnect();
  });

  it("allows an in-process (non-HTTP) mutation", async () => {
    const res = await caller.connect({ adapter: "inmemory" });
    expect(res.ok).toBe(true);
  });
});
