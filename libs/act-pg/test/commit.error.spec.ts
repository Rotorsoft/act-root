import { Committed, dispose, Schemas } from "@rotorsoft/act";
import { Pool, QueryResult } from "pg";
import { PostgresStore } from "../src";

const db = new PostgresStore("commit_error_test");

const query = (
  sql: string
): Promise<QueryResult<Committed<Schemas, keyof Schemas>>> => {
  const commit = sql.indexOf("COMMIT");
  if (commit > 0) return Promise.reject(Error("mocked commit error"));

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
});
