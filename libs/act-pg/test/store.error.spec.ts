import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresStore } from "../src/index.js";

describe("PostgresStore error branches", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should handle error in PostgresStore.commit notify", async () => {
    const store = new PostgresStore({ port: 5431, table: "store_error_test" });
    const fakeClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ version: 1 }] })
        .mockResolvedValueOnce({ rows: [{ name: "E", id: 1 }] })
        .mockRejectedValueOnce(new Error("fail")),
      release: vi.fn(),
    };
    vi.spyOn((await import("pg")).Pool.prototype, "connect").mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      fakeClient as any
    );
    await expect(
      store.commit(
        "s",
        [{ name: "E", data: {} }],
        { correlation: "c", causation: {} },
        1
      )
    ).rejects.toThrow();
  });

  it("should handle error in PostgresStore.ack", async () => {
    const store = new PostgresStore({ port: 5431, table: "store_error_test" });
    const fakeClient = {
      query: vi.fn().mockRejectedValue(new Error("fail")),
      release: vi.fn(),
    };
    vi.spyOn((await import("pg")).Pool.prototype, "connect").mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      fakeClient as any
    );
    await expect(
      store.ack([{ stream: "s", by: "b", at: 1, retry: 0, block: false }])
    ).resolves.toBeUndefined();
  });

  it("should cover catch block in PostgresStore.ack (fallback ROLLBACK)", async () => {
    const store = new PostgresStore({ port: 5431, table: "store_error_test" });
    const fakeClient = {
      query: vi
        .fn()
        .mockRejectedValueOnce(new Error("fail ack"))
        .mockRejectedValueOnce(new Error("fail rollback")),
      release: vi.fn(),
    };
    vi.spyOn((await import("pg")).Pool.prototype, "connect").mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      fakeClient as any
    );
    // Should not throw, but should cover the catch and fallback
    await expect(
      store.ack([{ stream: "s", by: "b", at: 1, retry: 0, block: false }])
    ).resolves.toBeUndefined();
    expect(fakeClient.query).toHaveBeenCalled();
    expect(fakeClient.release).toHaveBeenCalled();
  });

  it("should cover catch block in PostgresStore.ack (fallback ROLLBACK succeeds)", async () => {
    const store = new PostgresStore({ port: 5431, table: "store_error_test" });
    const fakeClient = {
      query: vi
        .fn()
        .mockRejectedValueOnce(new Error("fail ack"))
        .mockResolvedValueOnce(undefined), // ROLLBACK succeeds
      release: vi.fn(),
    };
    vi.spyOn((await import("pg")).Pool.prototype, "connect").mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      fakeClient as any
    );
    await expect(
      store.ack([{ stream: "s", by: "b", at: 1, retry: 0, block: false }])
    ).resolves.toBeUndefined();
    expect(fakeClient.query).toHaveBeenCalledTimes(2);
    expect(fakeClient.release).toHaveBeenCalled();
  });

  it("should handle error in PostgresStore.seed and cover throw", async () => {
    vi.resetModules();
    const store = new PostgresStore({ port: 5431, table: "store_error_test" });
    const fakeClient = {
      query: vi.fn().mockRejectedValue(new Error("fail seed")),
      release: vi.fn(),
    };
    vi.spyOn((await import("pg")).Pool.prototype, "connect").mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      fakeClient as any
    );
    let thrown = false;
    try {
      await store.seed();
    } catch (err) {
      thrown = true;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("fail seed");
      expect(fakeClient.release).toHaveBeenCalled();
    }
    expect(thrown).toBe(true);
  });

  it("should cover catch block in PostgresStore.ack (fallback ROLLBACK throws)", async () => {
    const store = new PostgresStore({ port: 5431, table: "store_error_test" });
    const fakeClient = {
      query: vi
        .fn()
        .mockRejectedValueOnce(new Error("fail ack"))
        .mockRejectedValueOnce(new Error("fail rollback")),
      release: vi.fn(),
    };
    vi.spyOn((await import("pg")).Pool.prototype, "connect").mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      fakeClient as any
    );
    // Should not throw, but should cover the catch and fallback
    await expect(
      store.ack([{ stream: "s", by: "b", at: 1, retry: 0, block: false }])
    ).resolves.toBeUndefined();
    expect(fakeClient.query).toHaveBeenCalled();
    expect(fakeClient.release).toHaveBeenCalled();
  });
});
