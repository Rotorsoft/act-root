/**
 * Connection state machine tests (ACT-1131).
 *
 * Real InMemoryStore — no mocking. `connect({ adapter: "inmemory" })`
 * constructs a fresh store, `getActiveStore()` returns it so tests can
 * read back the same instance the router holds. ACT-1123 added the
 * SQLite branch — its happy-path / sad-path tests live below and use
 * real `SqliteStore` instances against tempdir files.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteStore } from "@rotorsoft/act-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { getActiveStore, inspectorRouter } from "../src/server/router.js";

const caller = inspectorRouter.createCaller({});

afterEach(async () => {
  await caller.disconnect();
});

describe("status", () => {
  it("reports disconnected before connect", async () => {
    expect(await caller.status()).toEqual({
      connected: false,
      adapter: null,
      target: null,
    });
  });

  it("reports connected + adapter kind after connect(inmemory)", async () => {
    await caller.connect({ adapter: "inmemory" });
    expect(await caller.status()).toEqual({
      connected: true,
      adapter: "inmemory",
      target: "memory",
    });
  });

  it("reports disconnected again after disconnect", async () => {
    await caller.connect({ adapter: "inmemory" });
    await caller.disconnect();
    expect(await caller.status()).toEqual({
      connected: false,
      adapter: null,
      target: null,
    });
  });
});

describe("connect", () => {
  it("returns the inmemory adapter config on success", async () => {
    expect(await caller.connect({ adapter: "inmemory" })).toEqual({
      ok: true,
      config: { adapter: "inmemory" },
    });
    expect(getActiveStore()).not.toBeNull();
  });

  it("disposes the previous store when reconnecting", async () => {
    await caller.connect({ adapter: "inmemory" });
    const first = getActiveStore();
    expect(first).not.toBeNull();
    await caller.connect({ adapter: "inmemory" });
    expect(getActiveStore()).not.toBe(first);
  });
});

describe("disconnect", () => {
  it("is a no-op when not connected", async () => {
    expect(await caller.disconnect()).toEqual({ ok: true });
  });

  it("clears the active store", async () => {
    await caller.connect({ adapter: "inmemory" });
    expect(getActiveStore()).not.toBeNull();
    await caller.disconnect();
    expect(getActiveStore()).toBeNull();
  });
});

describe("writeMode", () => {
  it("reports read-only when ACT_INSPECTOR_WRITE is not set", async () => {
    const mode = await caller.writeMode();
    expect(mode.enabled).toBe(false);
    expect(mode.reason).toMatch(/ACT_INSPECTOR_WRITE/);
  });
});

describe("audit", () => {
  it("returns an empty entries list and the configured capacity", async () => {
    const result = await caller.audit();
    expect(result.entries).toEqual([]);
    expect(result.capacity).toBeGreaterThan(0);
  });
});

describe("getStore guard", () => {
  it("rejects read procedures before connect", async () => {
    await expect(caller.query({})).rejects.toThrow("Not connected to a store");
  });
});

describe("discover", () => {
  it("returns an empty list when no PG servers are reachable", async () => {
    // Privileged port — not accepting TCP connections in any reasonable
    // test environment. probePort returns false; discover short-circuits
    // before any PG auth attempt. `kind` defaults to "pg" so the input
    // shape stays back-compat with the pre-ACT-1122 frontend.
    const result = await caller.discover({
      host: "127.0.0.1",
      portFrom: 1,
      portTo: 1,
    });
    expect(result).toEqual({ ok: true, stores: [] });
  });
});

describe("transfer (unified backup / restore / cross-adapter) — ACT-1128", () => {
  it("refuses `current` source before any connect", async () => {
    await expect(
      caller.transfer({
        source: { adapter: "current" },
        target: { adapter: "download" },
      })
    ).rejects.toThrow(/current.*unavailable/);
  });

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

  it("dry-run reports counts without touching the target", async () => {
    await caller.connect({ adapter: "inmemory" });
    const store = getActiveStore()!;
    await store.commit("dry-stream", [{ name: "Tick", data: {} }], {
      correlation: "dry",
      causation: {},
    });
    const baselineEntries = (await caller.audit()).entries.length;
    const result = await caller.transfer({
      source: { adapter: "current" },
      target: { adapter: "download" },
      dry_run: true,
    });
    expect(result.result.kept).toBe(1);
    expect(result.csv).toBeNull();
    // No audit entry on a dry-run.
    expect((await caller.audit()).entries.length).toBe(baselineEntries);
  });
});

describe("connect (sqlite)", () => {
  let dir: string;

  // Build a real Act SQLite file in a tempdir for each test, dispose at
  // the end. Uses `SqliteStore.seed()` so the file actually has the
  // events/streams tables the connect-time probe checks for.
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

  it("connects to a real Act SQLite file", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "act-inspector-conn-sqlite-"));
    try {
      const file = await buildActFile();
      const result = await caller.connect({ adapter: "sqlite", file });
      expect(result).toEqual({
        ok: true,
        config: { adapter: "sqlite", file, table: "events" },
      });
      expect(await caller.status()).toEqual({
        connected: true,
        adapter: "sqlite",
        target: file,
      });
      expect(getActiveStore()).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails when the file has no Act schema", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "act-inspector-conn-sqlite-bad-"));
    try {
      // SqliteStore without seed() — file exists but has no `events`
      // table. The 1-row probe rejects.
      const file = path.join(dir, "empty.db");
      const empty = new SqliteStore({ url: `file:${file}` });
      try {
        // Force libsql to materialize the file with NO Act schema.
        // Any SELECT works.
        await empty
          .query<Record<string, never>>(() => {}, { limit: 1 })
          .catch(() => {});
      } finally {
        await empty.dispose();
      }
      await expect(caller.connect({ adapter: "sqlite", file })).rejects.toThrow(
        /Connection failed/
      );
      expect(getActiveStore()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("supports transfer on a SQLite-backed connection (ACT-1128)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "act-inspector-conn-sqlite-rs-"));
    try {
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
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
