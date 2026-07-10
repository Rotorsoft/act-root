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

  // The `current`-target restore paths (upload → current, the audit
  // capture, the malformed-upload validation error) require write-mode,
  // which is gated off by default (#1194). They live in
  // transfer-current.spec.ts, which enables ACT_INSPECTOR_WRITE. This
  // file stays read-only so the `writeMode` "read-only" assertion above
  // holds.

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

  // The SQLite-backed `current`-target restore round-trip requires
  // write-mode; it lives in transfer-current.spec.ts (#1194).
});
