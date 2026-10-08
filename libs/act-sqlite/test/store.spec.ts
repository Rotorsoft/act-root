import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { type Committed, dispose, type Schemas, store } from "@rotorsoft/act";
import { SqliteStore } from "../src/index.js";
import { actor, app, buildApp, setApp } from "./app.js";

// Co-locate the SQLite scratch file with the test that owns it so
// the WAL/SHM sidecars don't leak into the repo root. The whole
// test/ folder is the package's working set; vitest happens to run
// from the workspace root, which is why `file:test-store.db` was
// landing files in `/Users/.../act/`.
const DB_PATH = join(import.meta.dirname, "test-store.db");

// Contract-level cases live in `store-tck.spec.ts` (via the shared
// Store TCK in `@rotorsoft/act-tck`). This file only covers
// SQLite-specific implementation details: the LIKE-translation of
// regex-shaped stream patterns and an end-to-end app smoke test.

describe("sqlite store (adapter-specific)", () => {
  beforeAll(async () => {
    store(new SqliteStore({ url: `file:${DB_PATH}` }));
    await store().drop();
    await store().seed();
    // Build orchestrator AFTER injecting the store (notify wiring binds
    // at construction; late injection wouldn't take).
    setApp(buildApp());
  });

  afterAll(async () => {
    await dispose()();
    // Unlink the .db AND the WAL/SHM sidecars — WAL mode produces all
    // three and only deleting `.db` leaves the journal files behind.
    for (const ext of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(DB_PATH + ext);
      } catch {
        // file may not exist
      }
    }
  });

  it("works end-to-end with the act app", async () => {
    await app.do("increment", { stream: "c1", actor }, {});
    await app.do("increment", { stream: "c1", actor }, {});
    await app.do("decrement", { stream: "c1", actor }, {});

    const events: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => events.push(e), {
      stream: "c1",
      stream_exact: true,
    });
    expect(events.length).toBe(3);
    expect(events.filter((e) => e.name === "incremented").length).toBe(2);
    expect(events.filter((e) => e.name === "decremented").length).toBe(1);
  });
});
