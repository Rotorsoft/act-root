import { ConcurrencyError } from "@rotorsoft/act";
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

  it("commit: rolls back and rethrows on INSERT failure", async () => {
    const client = mockClientFailOn("INSERT INTO events");
    (db as unknown as { client: unknown }).client = client;
    await expect(
      db.commit("s", [{ name: "E", data: {} }], {
        correlation: "",
        causation: {},
      })
    ).rejects.toThrow(/mocked INSERT INTO events error/);
    expect(client._tx.rollback).toHaveBeenCalled();
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

  it("subscribe: rolls back and rethrows on INSERT failure", async () => {
    const client = mockClientFailOn("INSERT OR IGNORE INTO streams");
    (db as unknown as { client: unknown }).client = client;
    await expect(db.subscribe([{ stream: "x" }])).rejects.toThrow(
      /INSERT OR IGNORE/
    );
    expect(client._tx.rollback).toHaveBeenCalled();
  });

  it("claim: rolls back and rethrows on SELECT failure", async () => {
    const client = mockClientFailOn("SELECT stream, source, at FROM streams");
    (db as unknown as { client: unknown }).client = client;
    await expect(db.claim(1, 0, "w", 1000)).rejects.toThrow(/SELECT stream/);
    expect(client._tx.rollback).toHaveBeenCalled();
  });

  it("ack: rolls back and rethrows on UPDATE failure", async () => {
    const client = mockClientFailOn("UPDATE streams SET at");
    (db as unknown as { client: unknown }).client = client;
    await expect(
      db.ack([{ stream: "x", at: 1, by: "w", retry: 0, lagging: false }])
    ).rejects.toThrow(/UPDATE streams SET at/);
    expect(client._tx.rollback).toHaveBeenCalled();
  });

  it("block: rolls back and rethrows on UPDATE failure", async () => {
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
    ).rejects.toThrow(/UPDATE streams SET blocked/);
    expect(client._tx.rollback).toHaveBeenCalled();
  });

  it("reset: rolls back and rethrows on UPDATE failure", async () => {
    const client = mockClientFailOn("UPDATE streams SET at = -1");
    (db as unknown as { client: unknown }).client = client;
    await expect(db.reset(["x"])).rejects.toThrow(/UPDATE streams SET at = -1/);
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
});
