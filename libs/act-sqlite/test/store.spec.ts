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

  it("translates a regex-shaped stream pattern to LIKE", async () => {
    await store().commit("regex-A", [{ name: "rt", data: {} }], {
      correlation: "",
      causation: {},
    });
    await store().commit("regex-B", [{ name: "rt", data: {} }], {
      correlation: "",
      causation: {},
    });
    const wildcard: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => wildcard.push(e), { stream: "regex-.*" });
    expect(wildcard.length).toBe(2);
    // Single-char `.` translates to LIKE `_`.
    const single: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => single.push(e), { stream: "regex-." });
    expect(single.length).toBe(2);
  });

  it("honors caller-supplied anchors in LIKE translation", async () => {
    await store().commit("anchor-prefix-1", [{ name: "ap", data: {} }], {
      correlation: "",
      causation: {},
    });
    await store().commit("anchor-prefix-2", [{ name: "ap", data: {} }], {
      correlation: "",
      causation: {},
    });
    await store().commit("tail-anchor-suffix", [{ name: "ap", data: {} }], {
      correlation: "",
      causation: {},
    });

    const startsWith: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => startsWith.push(e), {
      stream: "^anchor-prefix.*",
    });
    expect(startsWith.length).toBe(2);

    const endsWith: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => endsWith.push(e), { stream: ".*suffix$" });
    expect(endsWith.length).toBe(1);
    expect(endsWith[0].stream).toBe("tail-anchor-suffix");

    const exact: Committed<Schemas, keyof Schemas>[] = [];
    await store().query((e) => exact.push(e), {
      stream: "^anchor-prefix-1$",
    });
    expect(exact.length).toBe(1);
    expect(exact[0].stream).toBe("anchor-prefix-1");
  });

  it("claims streams whose dynamic source pattern matches existing events", async () => {
    await store().commit("src-pat-alpha", [{ name: "sp", data: {} }], {
      correlation: "",
      causation: {},
    });
    await store().commit("src-pat-beta", [{ name: "sp", data: {} }], {
      correlation: "",
      causation: {},
    });
    await store().subscribe([
      { stream: "src-listener", source: "^src-pat-.*" },
    ]);

    const leases = await store().claim(10, 0, "src-worker", 30000);
    const target = leases.find((l) => l.stream === "src-listener");
    expect(target).toBeDefined();
    expect(target!.source).toBe("^src-pat-.*");
    if (leases.length) await store().ack(leases.map((l) => ({ ...l, at: 0 })));
  });

  it("does not claim when the source pattern matches no events", async () => {
    await store().subscribe([
      { stream: "src-no-match", source: "^never-matches-anything-.*" },
    ]);
    const leases = await store().claim(10, 0, "ghost-worker", 30000);
    expect(leases.find((l) => l.stream === "src-no-match")).toBeUndefined();
    if (leases.length) await store().ack(leases.map((l) => ({ ...l, at: 0 })));
  });
});
