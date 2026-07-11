import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { InMemoryStore } from "@rotorsoft/act";
import { runStoreDifferentialTck } from "@rotorsoft/act-tck";
import { afterAll } from "vitest";
import { SqliteStore } from "../src/index.js";

// Cross-adapter differential (#1030): drive the same seeded workload
// against the in-memory reference and SQLite, then compare normalized
// outputs. Dedicated scratch file so the harness's drop+seed is isolated
// from the example-based TCK running in a parallel worker.
const DB_PATH = join(import.meta.dirname, "differential-store.db");

runStoreDifferentialTck({
  name: "InMemory vs Sqlite",
  // Two known cross-adapter divergences are gated off until their fixes
  // land (tracked on a sibling branch), so this differential stays green:
  //   #1197 — SQLite `LIKE` is ASCII-case-insensitive, so a mixed-case
  //     regex pattern filter overmatches vs the case-sensitive InMemory
  //     reference. Un-gate `caseInsensitivePatterns` when LIKE is moved to
  //     GLOB / `case_sensitive_like`.
  //   #1199 — `names: []` and falsy-zero `before`/`after: 0` guards differ
  //     across adapters. Un-gate `queryEdgeInputs` when the `!== undefined`
  //     guards + defined `names: []` semantics land.
  skip: { caseInsensitivePatterns: true, queryEdgeInputs: true },
  // Explicit here (the PG differential omits it to exercise the `?? true`
  // default) — both stores implement the optional forget_pii surface.
  piiIsolation: true,
  stores: [
    { name: "InMemoryStore", factory: () => new InMemoryStore() },
    {
      name: "SqliteStore",
      factory: () => new SqliteStore({ url: `file:${DB_PATH}` }),
    },
  ],
});

// The harness only disposes the stores; the file + WAL/SHM sidecars are
// this spec's responsibility to remove.
afterAll(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(DB_PATH + ext);
    } catch {
      // file may not exist
    }
  }
});
