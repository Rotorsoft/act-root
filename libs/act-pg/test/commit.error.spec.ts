import {
  type Committed,
  ConcurrencyError,
  dispose,
  type Schemas,
} from "@rotorsoft/act";
import { Pool, type QueryResult } from "pg";
import { PostgresStore } from "../src/index.js";

const query = (
  sql: string
): Promise<QueryResult<Committed<Schemas, keyof Schemas>>> => {
  // The post-INSERT path issues `SELECT pg_notify(...)` and then a
  // standalone `COMMIT`. Match either to simulate a failure on the
  // commit-side of the transaction.
  if (sql.includes("COMMIT") || sql.includes("pg_notify"))
    return Promise.reject(Error("mocked commit error"));

  return Promise.resolve({
    rowCount: 1,
    rows: [
      {
        id: 1,
        name: "test1",
        data: {},
        stream: "stream",
        version: 1,
        created: new Date(),
      },
    ],
    command: undefined,
    oid: undefined,
    fields: undefined,
  } as any);
};

describe("commit error", () => {
  let db: PostgresStore;

  beforeAll(async () => {
    db = new PostgresStore({ port: 5431, table: "commit_error_test" });
    await db.drop();
    await db.seed();
  });

  afterAll(async () => {
    await dispose()();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should throw concurrecy error when committing", async () => {
    vi.spyOn(Pool.prototype, "connect").mockImplementation(() => ({
      query,
      release: (): void => {
        return;
      },
    }));
    await expect(
      db.commit("stream", [{ name: "test", data: {} }], {
        correlation: "",
        causation: {},
      })
    ).rejects.toThrow();
  });

  it("converts a PG unique-violation on INSERT into ConcurrencyError", async () => {
    // Mock pool: SELECT returns max version 4, INSERT throws PG 23505.
    // Without the conversion, callers would see a raw pg error and not
    // know to retry. With it, they see ConcurrencyError and the standard
    // retry path applies.
    vi.spyOn(Pool.prototype, "connect").mockImplementation(() => ({
      query: (sql: string) => {
        if (sql.includes("SELECT version")) {
          return Promise.resolve({
            rowCount: 1,
            rows: [{ version: 4 }],
          } as QueryResult);
        }
        if (sql.includes("INSERT")) {
          const err = new Error(
            'duplicate key value violates unique constraint "events_stream_ix"'
          ) as Error & { code: string };
          err.code = "23505";
          return Promise.reject(err);
        }
        return Promise.resolve({
          rowCount: 0,
          rows: [],
          command: "",
          oid: 0,
          fields: [],
        } as QueryResult);
      },
      release: (): void => undefined,
    }));
    await expect(
      db.commit("stream", [{ name: "test", data: {} }], {
        correlation: "",
        causation: {},
      })
    ).rejects.toBeInstanceOf(ConcurrencyError);
  });
});
