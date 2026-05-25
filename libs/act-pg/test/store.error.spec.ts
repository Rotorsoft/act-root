vi.mock("pg", () => {
  const Pool = vi.fn().mockImplementation(function (this: any) {
    return this;
  });
  Pool.prototype.query = () => {};
  Pool.prototype.end = () => {};
  Pool.prototype.connect = () => {};
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
import { PostgresStore } from "../src/postgres-store.js";

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
    it("returns defaults on empty input", async () => {
      // Empty input still queries max_at via client
      vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue(
        // @ts-expect-error mock
        makeClient(
          vi
            .fn()
            .mockResolvedValueOnce({}) // BEGIN
            .mockResolvedValueOnce({ rows: [{ max: null }] }) // SELECT MAX(at)
            .mockResolvedValueOnce({}) // COMMIT
        )
      );
      const result = await store.subscribe([]);
      expect(result).toEqual({ subscribed: 0, watermark: -1 });
    });

    it("handles undefined rowCount in INSERT", async () => {
      vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue(
        // @ts-expect-error mock
        makeClient(
          vi
            .fn()
            .mockResolvedValueOnce({}) // BEGIN
            .mockResolvedValueOnce({ rowCount: undefined }) // INSERT
            .mockResolvedValueOnce({ rowCount: 0 }) // priority UPDATE (ACT-102)
            .mockResolvedValueOnce({ rowCount: 0 }) // lane UPDATE (ACT-1103)
            .mockResolvedValueOnce({ rows: [{ max: 42 }] }) // SELECT MAX(at)
            .mockResolvedValueOnce({}) // COMMIT
        )
      );
      const result = await store.subscribe([{ stream: "s" }]);
      expect(result).toEqual({ subscribed: 0, watermark: 42 });
    });

    it("swallows DB error", async () => {
      vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue(
        // @ts-expect-error mock
        makeClient(vi.fn().mockRejectedValue(new Error("subscribe error")))
      );
      const result = await store.subscribe([{ stream: "s" }]);
      expect(result).toEqual({ subscribed: 0, watermark: -1 });
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

  describe("notify", () => {
    // The notify subscription is opt-in via `notify: true` in the
    // store config — without it, `store.notify` is undefined and the
    // orchestrator never wires LISTEN/NOTIFY.
    let notifyStore: PostgresStore;
    beforeEach(() => {
      notifyStore = new PostgresStore({
        port: 5431,
        table: "store_error_test",
        notify: true,
      });
    });

    it("is undefined when config.notify is false", () => {
      expect(store.notify).toBeUndefined();
      expect(notifyStore.notify).toBeTypeOf("function");
    });

    it("ignores notifications on a different channel", async () => {
      // Hold the registered `notification` listener so we can call it
      // directly with a synthetic message — pg-pool can in theory
      // deliver buffered notifications from a reused client even after
      // we've LISTEN'd a fresh channel.
      let captured: ((msg: any) => void) | undefined;
      const client = {
        query: vi.fn().mockResolvedValue({}),
        on: vi.fn((event: string, fn: any) => {
          if (event === "notification") captured = fn;
        }),
        removeListener: vi.fn(),
        release: vi.fn(),
      };
      vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue(
        // @ts-expect-error mock
        client
      );
      const handler = vi.fn();
      await notifyStore.notify!(handler);
      expect(captured).toBeTypeOf("function");
      // Synthetic message on a foreign channel — must be ignored.
      captured!({ channel: "some_other_channel", payload: "{}" });
      expect(handler).not.toHaveBeenCalled();
    });

    it("releases the listen client when LISTEN throws", async () => {
      // Successful connect, but LISTEN fails — exercises the clean-up
      // branch in `notify()` that detaches the listener and destroys
      // the client before rethrowing. Without this branch, a bad LISTEN
      // would leak a connection from the pool.
      const release = vi.fn();
      const on = vi.fn();
      const removeListener = vi.fn();
      const client = {
        query: vi
          .fn()
          .mockImplementationOnce(() =>
            Promise.reject(new Error("listen fail"))
          ),
        on,
        removeListener,
        release,
      };
      vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue(
        // @ts-expect-error mock
        client
      );
      await expect(notifyStore.notify!(() => {})).rejects.toThrow(
        "listen fail"
      );
      // Listener attached then detached; client released with destroy=true.
      expect(on).toHaveBeenCalledWith("notification", expect.any(Function));
      expect(removeListener).toHaveBeenCalledWith(
        "notification",
        expect.any(Function)
      );
      expect(release).toHaveBeenCalledWith(true);
    });
  });

  describe("prioritize", () => {
    it("returns 0 when rowCount is undefined (defensive)", async () => {
      vi.spyOn(pg.Pool.prototype, "query").mockResolvedValue(
        // @ts-expect-error mock — pg type says rowCount: number | null
        { rowCount: null }
      );
      const result = await store.prioritize({}, 5);
      expect(result).toBe(0);
    });
  });

  describe("reset", () => {
    it("returns 0 when rowCount is undefined for filter form (defensive)", async () => {
      vi.spyOn(pg.Pool.prototype, "query").mockResolvedValue(
        // @ts-expect-error mock — pg type says rowCount: number | null
        { rowCount: null }
      );
      const result = await store.reset({ stream: "^never-matches-" });
      expect(result).toBe(0);
    });
  });

  describe("unblock", () => {
    it("returns 0 when rowCount is undefined for array form (defensive)", async () => {
      vi.spyOn(pg.Pool.prototype, "query").mockResolvedValue(
        // @ts-expect-error mock — pg type says rowCount: number | null
        { rowCount: null }
      );
      const result = await store.unblock(["never-blocked"]);
      expect(result).toBe(0);
    });

    it("returns 0 when rowCount is undefined for filter form (defensive)", async () => {
      vi.spyOn(pg.Pool.prototype, "query").mockResolvedValue(
        // @ts-expect-error mock — pg type says rowCount: number | null
        { rowCount: null }
      );
      const result = await store.unblock({ stream: "^never-blocked-" });
      expect(result).toBe(0);
    });
  });

  describe("restore", () => {
    it("swallows ROLLBACK error after a failed restore", async () => {
      // BEGIN succeeds, first TRUNCATE throws, then ROLLBACK ITSELF
      // throws — the catch in `restore` wraps ROLLBACK in
      // `.catch(() => {})` so the original error propagates rather
      // than the rollback's. Without this swallow path being
      // exercised, the function would never be called and coverage
      // would dip below 100% on PostgresStore.
      const queryMock = vi
        .fn()
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockRejectedValueOnce(new Error("truncate fail")) // TRUNCATE events
        .mockRejectedValueOnce(new Error("rollback fail")); // ROLLBACK
      vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue(
        // @ts-expect-error mock
        makeClient(queryMock)
      );
      const empty: AsyncIterable<{
        id: number;
        name: string;
        data: unknown;
        stream: string;
        version: number;
        created: Date;
        meta: { correlation: string; causation: Record<string, never> };
      }> = (async function* () {
        // never yields — TRUNCATE fails before we get here
      })();
      await expect(store.restore(empty)).rejects.toThrow("truncate fail");
    });
  });
});
