/**
 * Connection state machine tests (ACT-1131).
 *
 * Real InMemoryStore — no mocking. `connect({ adapter: "inmemory" })`
 * constructs a fresh store, `getActiveStore()` returns it so tests can
 * read back the same instance the router holds.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getActiveStore, inspectorRouter } from "../src/server/router.js";

const caller = inspectorRouter.createCaller({});

afterEach(async () => {
  await caller.disconnect();
});

describe("status", () => {
  it("reports disconnected before connect", async () => {
    expect(await caller.status()).toEqual({ connected: false });
  });

  it("reports connected after connect(inmemory)", async () => {
    await caller.connect({ adapter: "inmemory" });
    expect(await caller.status()).toEqual({ connected: true });
  });

  it("reports disconnected again after disconnect", async () => {
    await caller.connect({ adapter: "inmemory" });
    await caller.disconnect();
    expect(await caller.status()).toEqual({ connected: false });
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

describe("restore adapter guard", () => {
  it("refuses to run on a non-PG adapter", async () => {
    await caller.connect({ adapter: "inmemory" });
    await expect(caller.restore({ csv: "" })).rejects.toThrow(
      "Restore currently requires a PG-backed inspector connection"
    );
  });

  it("refuses to run before any connect", async () => {
    await expect(caller.restore({ csv: "" })).rejects.toThrow(
      "Not connected to a store"
    );
  });
});
