/**
 * `runDiscovery` dispatcher tests (ACT-1122).
 *
 * The dispatcher's only job is to route by `input.kind`. The
 * underlying probes have their own coverage; here we just verify the
 * routing produces the right adapter-specific result shape.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteStore } from "@rotorsoft/act-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDiscovery } from "../../src/server/discovery/index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "act-inspector-dispatch-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runDiscovery", () => {
  it("dispatches to the PG probe and returns no rows for an unreachable port", async () => {
    const stores = await runDiscovery({
      kind: "pg",
      host: "127.0.0.1",
      portFrom: 1,
      portTo: 1,
    });
    expect(stores).toEqual([]);
  });

  it("dispatches to the SQLite probe and finds Act-shaped files", async () => {
    const file = path.join(dir, "store.db");
    const store = new SqliteStore({ url: `file:${file}` });
    try {
      await store.seed();
    } finally {
      await store.dispose();
    }
    const stores = await runDiscovery({ kind: "sqlite", dir });
    expect(stores).toHaveLength(1);
    expect(stores[0]).toMatchObject({ kind: "sqlite", file });
  });
});
