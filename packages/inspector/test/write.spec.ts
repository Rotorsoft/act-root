/**
 * Write-gated procedures (ACT-1131): `prioritize` + the `writeMode`
 * enabled branch + the `audit` capture path.
 *
 * `writeEnabled` is a module-level constant in `router.ts` captured
 * from `process.env.ACT_INSPECTOR_WRITE` at first import. `vi.hoisted`
 * sets the env var before the import is evaluated so the router sees
 * `writeEnabled === true` for this file.
 */
import type { InMemoryStore } from "@rotorsoft/act";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ACT_INSPECTOR_WRITE = "1";
});

const { getActiveStore, inspectorRouter } = await import(
  "../src/server/router.js"
);

const caller = inspectorRouter.createCaller({});
let store: InMemoryStore;

beforeEach(async () => {
  await caller.disconnect();
  await caller.connect({ adapter: "inmemory" });
  store = getActiveStore() as InMemoryStore;
  await store.subscribe([
    { stream: "stream-a", source: "src-a" },
    { stream: "stream-b", source: "src-b" },
  ]);
});

describe("writeMode (enabled)", () => {
  it("reports enabled when ACT_INSPECTOR_WRITE=1", async () => {
    expect(await caller.writeMode()).toEqual({ enabled: true, reason: null });
  });
});

describe("prioritize", () => {
  it("applies the requested priority and reports the count", async () => {
    const result = await caller.prioritize({ priority: 7, filter: {} });
    expect(result).toEqual({ ok: true, affected: 2 });
  });

  it("narrows by filter — single-stream exact match", async () => {
    const result = await caller.prioritize({
      priority: 3,
      filter: { stream: "stream-a", stream_exact: true },
    });
    expect(result.affected).toBe(1);
  });

  it("records each successful mutation in the audit log", async () => {
    // The audit log is module-level and persists across tests within
    // this file (it survives `disconnect`/`connect` by design — the
    // operator should see mutation history regardless of session). So
    // capture the baseline length first and assert on the delta.
    const before = (await caller.audit()).entries.length;
    await caller.prioritize({ priority: 5, filter: {} });
    await caller.prioritize({
      priority: 1,
      filter: { stream: "^stream-" },
    });
    const audit = await caller.audit();
    expect(audit.entries.length - before).toBe(2);
    // Newest first — our two newly-added entries lead the list.
    expect(audit.entries[0]).toMatchObject({
      action: "prioritize",
      priority: 1,
      affected: 2,
    });
    expect(audit.entries[1]).toMatchObject({
      action: "prioritize",
      priority: 5,
      affected: 2,
    });
    expect(audit.entries[0]!.timestamp).toMatch(/^\d{4}-/);
  });
});
