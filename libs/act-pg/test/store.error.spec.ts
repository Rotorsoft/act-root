vi.mock("pg", () => {
  const Pool = vi.fn().mockImplementation(function (this: any) {
    return this;
  });
  Pool.prototype.query = function () {};
  Pool.prototype.end = function () {};
  Pool.prototype.connect = function () {};
  return {
    Pool,
    types: { setTypeParser: vi.fn(), builtins: { JSONB: 0 } },
    default: {
      Pool,
      types: { setTypeParser: vi.fn(), builtins: { JSONB: 0 } },
    },
  };
});

import * as pg from "pg";
import { PostgresStore } from "../src/PostgresStore.js";

const makeClient = (queryMock: any) => ({
  query: queryMock,
  release: vi.fn(),
});

describe("PostgresStore", () => {
  let store: PostgresStore;

  beforeEach(() => {
    store = new PostgresStore({ port: 5431, table: "store_error_test" });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("seed", () => {
    it("logs and throws on error", async () => {
      // Simulate a client whose query throws after BEGIN
      const query = vi
        .fn()
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockRejectedValueOnce(new Error("seed fail")); // CREATE SCHEMA fails

      // @ts-expect-error mock
      vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue({
        query,
        release: vi.fn(),
      });
      await expect(store.seed()).rejects.toThrow("seed fail");
    });
  });

  describe("commit", () => {
    it("returns [] for empty events", async () => {
      // @ts-expect-error mock
      vi.spyOn(pg.Pool.prototype, "query").mockResolvedValue({ rows: [] });
      await expect(
        store.commit("stream", [], { correlation: "c", causation: {} })
      ).resolves.toEqual([]);
    });

    it("throws on DB error", async () => {
      vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue(
        // @ts-expect-error mock
        makeClient(vi.fn().mockRejectedValue(new Error("db error")))
      );
      await expect(
        store.commit("stream", [{ name: "E", data: {} }], {
          correlation: "c",
          causation: {},
        })
      ).rejects.toThrow("db error");
    });

    it("throws notify fail on NOTIFY/COMMIT failure", async () => {
      const queryMock = vi
        .fn()
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ version: 0 }] }) // SELECT version
        .mockResolvedValueOnce({ rows: [{ name: "E", id: 1 }] }) // INSERT
        .mockImplementationOnce(() => Promise.reject(new Error("notify fail"))) // NOTIFY/COMMIT
        .mockResolvedValue(Promise.resolve());

      vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue(
        // @ts-expect-error mock
        makeClient(queryMock)
      );
      await expect(
        store.commit("stream", [{ name: "E", data: {} }], {
          correlation: "c",
          causation: {},
        })
      ).rejects.toThrow("notify fail");
    });
  });

  describe("query", () => {
    it("covers no conditions branch", async () => {
      const store = new PostgresStore({
        port: 5431,
        table: "store_error_test",
      });
      const querySpy = vi
        .spyOn(pg.Pool.prototype, "query")
        // @ts-expect-error mock
        .mockResolvedValue({ rows: [], rowCount: 0 });
      const cb = vi.fn();

      await store.query(cb);
      expect(querySpy).toHaveBeenCalledWith(
        expect.stringContaining("SELECT *"),
        []
      );
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("claim", () => {
    it("swallows DB error", async () => {
      vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue(
        // @ts-expect-error mock
        makeClient(vi.fn().mockRejectedValue(new Error("claim error")))
      );
      await expect(store.claim(5, 5, "w", 10000)).resolves.toEqual([]);
    });
  });

  describe("subscribe", () => {
    it("returns 0 on empty input", async () => {
      await expect(store.subscribe([])).resolves.toBe(0);
    });
  });

  describe("ack", () => {
    it("swallows DB error", async () => {
      vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue(
        // @ts-expect-error mock
        makeClient(vi.fn().mockRejectedValue(new Error("ack error")))
      );
      await expect(
        store.ack([{ stream: "s", lagging: false, by: "a", at: 1, retry: 0 }])
      ).resolves.toEqual([]);
    });
  });

  describe("block", () => {
    it("swallows DB error", async () => {
      vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue(
        // @ts-expect-error mock
        makeClient(vi.fn().mockRejectedValue(new Error("block error")))
      );
      await expect(
        store.block([
          { stream: "s", lagging: false, by: "a", at: 1, retry: 0, error: "" },
        ])
      ).resolves.toEqual([]);
    });
  });
});
