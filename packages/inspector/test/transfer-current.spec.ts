/**
 * Transfer functional paths that write to a `current` target (ACT-1128),
 * relocated here from connection.spec.ts because the write-mode gate
 * (#1194) now refuses these unless ACT_INSPECTOR_WRITE=1. `vi.hoisted`
 * sets the env before the router module reads it at import time.
 *
 * SQLite `connect` file paths use a temp dir under cwd so the path
 * guard (#1194) — which only applies to `transfer` file slots, not the
 * connect file — is a non-issue and setup stays self-contained.
 */
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { SqliteStore } from "@rotorsoft/act-sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ACT_INSPECTOR_WRITE = "1";
});

const { getActiveStore, inspectorRouter } = await import(
  "../src/server/router.js"
);

const caller = inspectorRouter.createCaller({});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), "act-inspector-tc-"));
});

afterEach(async () => {
  await caller.disconnect();
  await rm(dir, { recursive: true, force: true });
});

async function buildActFile(name = "store.db"): Promise<string> {
  const file = path.join(dir, name);
  const store = new SqliteStore({ url: `file:${file}` });
  try {
    await store.seed();
  } finally {
    await store.dispose();
  }
  return file;
}

describe("transfer → current (write-mode enabled)", () => {
  it("rejects malformed upload CSV with a clear error", async () => {
    await caller.connect({ adapter: "inmemory" });
    await expect(
      caller.transfer({
        source: { adapter: "upload", csv: "" },
        target: { adapter: "current" },
      })
    ).rejects.toThrow(/at least one row/);
  });

  it("round-trips events: current → download → upload → current", async () => {
    await caller.connect({ adapter: "inmemory" });
    const store = getActiveStore()!;
    await store.commit(
      "round-trip-stream",
      [
        { name: "Opened", data: { id: 1 } },
        { name: "Updated", data: { id: 1, field: "x" } },
      ],
      { correlation: "round-trip", causation: {} }
    );
    const backup = await caller.transfer({
      source: { adapter: "current" },
      target: { adapter: "download" },
    });
    expect(backup.count).toBe(2);
    expect(backup.csv).toBeTruthy();
    // Reconnect (fresh inmemory store), then restore from the CSV bytes.
    await caller.connect({ adapter: "inmemory" });
    const result = await caller.transfer({
      source: { adapter: "upload", csv: backup.csv ?? "" },
      target: { adapter: "current" },
    });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(result.result.kept).toBe(2);
    expect(result.result.duration_ms).toBeGreaterThanOrEqual(0);
    const verify = await caller.query({});
    expect(verify.events).toHaveLength(2);
    expect(verify.events.map((e) => e.name)).toEqual(["Opened", "Updated"]);
  });

  it("records the destructive `current`-target path in the audit log", async () => {
    await caller.connect({ adapter: "inmemory" });
    const store = getActiveStore()!;
    await store.commit("audited-stream", [{ name: "Tick", data: {} }], {
      correlation: "audit",
      causation: {},
    });
    const backup = await caller.transfer({
      source: { adapter: "current" },
      target: { adapter: "download" },
    });
    await caller.connect({ adapter: "inmemory" });
    const baselineEntries = (await caller.audit()).entries.length;
    await caller.transfer({
      source: { adapter: "upload", csv: backup.csv ?? "" },
      target: { adapter: "current" },
    });
    const audit = await caller.audit();
    expect(audit.entries.length).toBe(baselineEntries + 1);
    const entry = audit.entries[0]!;
    expect(entry.action).toBe("restore");
    if (entry.action === "restore") {
      expect(entry.adapter).toBe("inmemory");
      expect(entry.result.kept).toBe(1);
    }
  });

  it("supports transfer on a SQLite-backed connection (ACT-1128)", async () => {
    const file = await buildActFile();
    await caller.connect({ adapter: "sqlite", file });
    const store = getActiveStore()!;
    await store.commit("sqlite-stream", [{ name: "Tick", data: { n: 1 } }], {
      correlation: "sqlite-transfer",
      causation: {},
    });
    const backup = await caller.transfer({
      source: { adapter: "current" },
      target: { adapter: "download" },
    });
    // Reconnect to a fresh SQLite file, then restore the CSV.
    const file2 = await buildActFile("store-2.db");
    await caller.connect({ adapter: "sqlite", file: file2 });
    const result = await caller.transfer({
      source: { adapter: "upload", csv: backup.csv ?? "" },
      target: { adapter: "current" },
    });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.result.kept).toBe(1);
  });
});
