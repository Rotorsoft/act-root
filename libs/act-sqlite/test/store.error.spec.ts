import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { ConcurrencyError, StoreError } from "@rotorsoft/act";
import { SqliteStore } from "../src/index.js";

type Stmt = string | { sql: string; args?: unknown[] };

const sqlOf = (s: Stmt) => (typeof s === "string" ? s : s.sql);

const okExecute = (stmt?: Stmt) => {
  void stmt;
  return Promise.resolve({
    rows: [],
    rowsAffected: 0,
    lastInsertRowid: 0,
    columns: [],
    columnTypes: [],
    toJSON: () => ({}),
  });
};

const txOk = () => ({
  execute: vi.fn<(stmt: Stmt) => Promise<unknown>>(okExecute),
  commit: vi.fn(() => Promise.resolve()),
  rollback: vi.fn(() => Promise.resolve()),
  close: vi.fn(),
});

/**
 * Build a mock libsql Client whose write transaction fails on `execute()`
 * for SQL statements containing `failOn`. All other executes resolve to a
 * neutral "no rows" result so prior steps in each method succeed.
 */
function mockClientFailOn(failOn: string) {
  const tx = {
    rollback: vi.fn(() => Promise.resolve()),
    commit: vi.fn(() => Promise.resolve()),
    close: vi.fn(),
    execute: vi.fn((stmt: Stmt) => {
      const sql = sqlOf(stmt);
      if (sql.includes(failOn))
        return Promise.reject(new Error(`mocked ${failOn} error`));
      // Provide neutral defaults for SELECTs
      if (sql.includes("MAX(version)")) {
        return Promise.resolve({
          rows: [{ v: -1 }],
          rowsAffected: 0,
          lastInsertRowid: 0,
        });
      }
      if (sql.includes("MAX(at)")) {
        return Promise.resolve({
          rows: [{ w: -1 }],
          rowsAffected: 0,
          lastInsertRowid: 0,
        });
      }
      if (sql.includes("COUNT(*)")) {
        return Promise.resolve({
          rows: [{ c: 0 }],
          rowsAffected: 0,
          lastInsertRowid: 0,
        });
      }
      if (sql.includes("SELECT stream, source, at FROM streams")) {
        return Promise.resolve({
          rows: [],
          rowsAffected: 0,
          lastInsertRowid: 0,
        });
      }
      if (sql.includes("SELECT 1 FROM events")) {
        return Promise.resolve({
          rows: [],
          rowsAffected: 0,
          lastInsertRowid: 0,
        });
      }
      return Promise.resolve({
        rows: [],
        rowsAffected: 1,
        lastInsertRowid: 1,
      });
    }),
  };
  return {
    transaction: vi.fn(() => Promise.resolve(tx)),
    execute: vi.fn(okExecute),
    close: vi.fn(),
    _tx: tx,
  };
}

describe("SqliteStore error paths", () => {
  let db: SqliteStore;

  beforeEach(() => {
    db = new SqliteStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs with default config (in-memory)", () => {
    const s = new SqliteStore();
    expect(s).toBeInstanceOf(SqliteStore);
  });

  it("accepts a custom url and authToken", () => {
    const s = new SqliteStore({ url: "file::memory:", authToken: "tok" });
    expect(s).toBeInstanceOf(SqliteStore);
  });

  it("commit: rolls back and wraps INSERT failure in StoreError (#1202)", async () => {
    const client = mockClientFailOn("INSERT INTO events");
    (db as unknown as { client: unknown }).client = client;
    // Parity with PG: a non-unique-violation driver error is wrapped in
    // StoreError('commit'), not rethrown raw.
    const err = await db
      .commit("s", [{ name: "E", data: {} }], {
        correlation: "",
        causation: {},
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err.operation).toBe("commit");
    expect((err.cause as Error).message).toMatch(/mocked INSERT INTO events/);
    expect(client._tx.rollback).toHaveBeenCalled();
  });

  it("commit: maps a (stream,version) unique collision to ConcurrencyError (#1202)", async () => {
    // A real DB with a v0 row already present. We stub ONLY the
    // version-probe SELECT to return a stale MAX(version)=-1, so commit
    // recomputes version=0 and the INSERT genuinely collides on the
    // UNIQUE(stream, version) index — the race PG maps via 23505. The
    // driver raises SQLITE_CONSTRAINT_UNIQUE; the adapter must surface
    // ConcurrencyError, not the raw libsql error.
    const DB_PATH = join(import.meta.dirname, `collide-${Date.now()}.db`);
    const real = new SqliteStore({ url: `file:${DB_PATH}` });
    await real.seed();
    await real.commit("collide", [{ name: "E", data: {} }], {
      correlation: "",
      causation: {},
    });
    const client = (real as unknown as { client: { transaction: unknown } })
      .client;
    const realTransaction = (
      client.transaction as (mode: string) => Promise<unknown>
    ).bind(client);
    (
      client as { transaction: (mode: string) => Promise<unknown> }
    ).transaction = async (mode: string) => {
      const tx = (await realTransaction(mode)) as {
        execute: (stmt: Stmt) => Promise<unknown>;
      };
      const realExecute = tx.execute.bind(tx);
      tx.execute = (stmt: Stmt) => {
        if (sqlOf(stmt).includes("MAX(version)"))
          return Promise.resolve({
            rows: [{ v: -1 }],
            rowsAffected: 0,
            lastInsertRowid: 0,
          });
        return realExecute(stmt);
      };
      return tx;
    };
    const err = await real
      .commit("collide", [{ name: "E", data: {} }], {
        correlation: "",
        causation: {},
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConcurrencyError);
    await real.dispose();
    for (const ext of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(DB_PATH + ext);
      } catch {
        // file may not exist
      }
    }
  });

  it("commit: throws ConcurrencyError when expectedVersion mismatches", async () => {
    const tx = txOk();
    tx.execute.mockImplementation((stmt: Stmt) => {
      const sql = sqlOf(stmt);
      if (sql.includes("MAX(version)")) {
        return Promise.resolve({
          rows: [{ v: 5 }],
          rowsAffected: 0,
          lastInsertRowid: 0,
        });
      }
      return okExecute();
    });
    (db as unknown as { client: unknown }).client = {
      transaction: () => Promise.resolve(tx),
      execute: okExecute,
      close: () => {},
    };
    await expect(
      db.commit(
        "s",
        [{ name: "E", data: {} }],
        { correlation: "", causation: {} },
        0
      )
    ).rejects.toThrow(ConcurrencyError);
    expect(tx.rollback).toHaveBeenCalled();
  });

  it("subscribe: rolls back and wraps INSERT failure in StoreError", async () => {
    const client = mockClientFailOn("INSERT OR IGNORE INTO streams");
    (db as unknown as { client: unknown }).client = client;
    const err = await db.subscribe([{ stream: "x" }]).catch((e) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err.operation).toBe("subscribe");
    expect((err.cause as Error).message).toMatch(/INSERT OR IGNORE/);
    expect(client._tx.rollback).toHaveBeenCalled();
  });

  it("claim: rolls back and wraps SELECT failure in StoreError", async () => {
    const client = mockClientFailOn(
      "SELECT stream, source, at, priority, lane FROM streams"
    );
    (db as unknown as { client: unknown }).client = client;
    await expect(db.claim(1, 0, "w", 1000)).rejects.toThrow(StoreError);
    expect(client._tx.rollback).toHaveBeenCalled();
  });

  it("ack: rolls back and wraps UPDATE failure in StoreError", async () => {
    const client = mockClientFailOn("SET at = ?");
    (db as unknown as { client: unknown }).client = client;
    await expect(
      db.ack([{ stream: "x", at: 1, by: "w", retry: 0, lagging: false }])
    ).rejects.toThrow(StoreError);
    expect(client._tx.rollback).toHaveBeenCalled();
  });

  it("block: rolls back and wraps UPDATE failure in StoreError", async () => {
    const client = mockClientFailOn("UPDATE streams SET blocked");
    (db as unknown as { client: unknown }).client = client;
    await expect(
      db.block([
        {
          stream: "x",
          at: 0,
          by: "w",
          retry: 0,
          lagging: false,
          error: "e",
        },
      ])
    ).rejects.toThrow(StoreError);
    expect(client._tx.rollback).toHaveBeenCalled();
  });

  it("defer: rolls back and wraps UPDATE failure in StoreError", async () => {
    const client = mockClientFailOn("UPDATE streams SET deferred_at");
    (db as unknown as { client: unknown }).client = client;
    await expect(db.defer(["x"], Date.now())).rejects.toThrow(StoreError);
    expect(client._tx.rollback).toHaveBeenCalled();
  });

  it("reset: rolls back and rethrows on UPDATE failure", async () => {
    const client = mockClientFailOn("UPDATE streams SET at = -1");
    (db as unknown as { client: unknown }).client = client;
    await expect(db.reset(["x"])).rejects.toThrow(/UPDATE streams SET at = -1/);
    expect(client._tx.rollback).toHaveBeenCalled();
  });

  it("unblock: rolls back and rethrows on UPDATE failure (array form)", async () => {
    const client = mockClientFailOn("UPDATE streams SET retry = -1");
    (db as unknown as { client: unknown }).client = client;
    await expect(db.unblock(["x"])).rejects.toThrow(
      /UPDATE streams SET retry = -1/
    );
    expect(client._tx.rollback).toHaveBeenCalled();
  });

  it("unblock: rolls back and rethrows on UPDATE failure (filter form)", async () => {
    const client = mockClientFailOn("UPDATE streams SET retry = -1");
    (db as unknown as { client: unknown }).client = client;
    await expect(db.unblock({ stream: "^x-" })).rejects.toThrow(
      /UPDATE streams SET retry = -1/
    );
    expect(client._tx.rollback).toHaveBeenCalled();
  });

  it("truncate: rolls back and rethrows on DELETE failure", async () => {
    const client = mockClientFailOn("DELETE FROM events");
    (db as unknown as { client: unknown }).client = client;
    await expect(db.truncate([{ stream: "x" }])).rejects.toThrow(
      /DELETE FROM events/
    );
    expect(client._tx.rollback).toHaveBeenCalled();
  });

  it("forget_pii: returns 0 when rowsAffected is undefined (defensive)", async () => {
    // libsql types `rowsAffected` as `number`, but tests guard the
    // adapter's `?? 0` fallback in case a driver returns `undefined`
    // for a no-op UPDATE.
    const client = {
      execute: vi.fn(() => Promise.resolve({ rowsAffected: undefined })),
      close: vi.fn(),
    };
    (db as unknown as { client: unknown }).client = client;
    const wiped = await db.forget_pii("never-existed");
    expect(wiped).toBe(0);
  });
});
