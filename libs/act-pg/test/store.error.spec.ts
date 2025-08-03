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
      const { logger } = await import("@rotorsoft/act");
      const errorSpy = vi.spyOn(logger, "error");
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
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to seed store:"),
        expect.any(Error)
      );
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

  describe("poll", () => {
    it("returns empty result on no rows", async () => {
      // @ts-expect-error mock
      vi.spyOn(pg.Pool.prototype, "query").mockResolvedValue({ rows: [] });
      await expect(store.poll(10, 1)).resolves.toEqual([]);
    });

    it("throws on DB error", async () => {
      vi.spyOn(pg.Pool.prototype, "query").mockRejectedValue(
        new Error("poll error") as any
      );
      await expect(store.poll(10, 1)).rejects.toThrow("poll error");
    });

    it("covers no rows branch", async () => {
      const store = new PostgresStore({
        port: 5431,
        table: "store_error_test",
      });
      vi.spyOn(pg.Pool.prototype, "query")
        // @ts-expect-error mock
        .mockResolvedValueOnce({ rows: [] })
        // @ts-expect-error mock
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const result = await store.poll(10, 1);
      expect(result).toEqual([]);
    });
  });

  describe("lease", () => {
    it("swallows DB error", async () => {
      vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue(
        // @ts-expect-error mock
        makeClient(vi.fn().mockRejectedValue(new Error("lease error")))
      );
      await expect(
        store.lease(
          [{ stream: "s", lagging: false, by: "a", at: 1, retry: 0 }],
          0
        )
      ).resolves.toEqual([]);
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
