import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "../src/adapters/InMemoryStore.js";
import { ValidationError } from "../src/types/errors.js";
import type { Registry } from "../src/types/registry.js";
import { ZodEmpty } from "../src/types/schemas.js";

const fakeLogger = {
  trace: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

let store: InMemoryStore;
vi.doMock("../src/ports.js", async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    logger: fakeLogger,
    store: () => store,
  };
});

describe("Act", () => {
  let act: any; // type any because of dynamic import
  let registry: Registry<any, any, any>;

  beforeEach(async () => {
    vi.clearAllMocks();
    fakeLogger.trace.mockClear();
    fakeLogger.warn.mockClear();
    fakeLogger.error.mockClear();
    store = new InMemoryStore();

    const { Act } = await import("../src/act.js");

    registry = {
      actions: {
        foo: {
          name: "foo",
          state: ZodEmpty,
          events: { E: ZodEmpty },
          actions: { foo: ZodEmpty },
          init: () => ({}),
          patch: { E: vi.fn() },
          on: { foo: vi.fn(() => ["E", {}] as const) },
        },
      },
      events: {
        E: {
          schema: ZodEmpty,
          reactions: new Map(),
        },
      },
    };
    act = new Act(registry, 1);
  });

  it("should emit committed event on do", async () => {
    const emitSpy = vi.spyOn(act, "emit");
    await act.do("foo", { stream: "s", actor: { id: "a", name: "a" } }, {});
    expect(emitSpy).toHaveBeenCalledWith("committed", expect.anything());
  });

  it("should return correct query result", async () => {
    await store.commit("s", [{ name: "E", data: {} }], {
      correlation: "c",
      causation: {},
    });
    const result = await act.query({}, (e: any) => e);
    expect(result.count).toBe(1);
    expect(result.first).toBeDefined();
    expect(result.last).toBeDefined();
  });

  it("should return 0 if drain is locked", async () => {
    // Covers the drainLocked branch in Act.drain
    act.drainLocked = true;
    const result = await act.drain();
    expect(result).toBe(0);
  });

  it("should handle drain with events and emit drained", async () => {
    await store.commit("s", [{ name: "E", data: {} }], {
      correlation: "c",
      causation: {},
    });
    const emitSpy = vi.spyOn(act, "emit");
    registry.events.E.reactions = new Map([
      [
        "handler",
        {
          handler: vi.fn(),
          resolver: () => "s",
          options: { maxRetries: 1, blockOnError: true, retryDelayMs: 0 },
        },
      ],
    ]);
    await act.drain();
    expect(fakeLogger.trace).toHaveBeenCalled();
    expect(fakeLogger.warn).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith("drained", expect.any(Array));
  });

  it("should handle drain with reaction warning and block", async () => {
    await store.commit("s", [{ name: "E", data: {} }], {
      correlation: "c",
      causation: {},
    });
    registry.events.E.reactions = new Map([
      [
        "handler",
        {
          handler: vi
            .fn()
            .mockRejectedValue(new ValidationError("fail", {}, {})),
          resolver: () => "s",
          options: { maxRetries: 0, blockOnError: true, retryDelayMs: 0 },
        },
      ],
    ]);
    await act.drain();
    expect(fakeLogger.error).toHaveBeenCalled();
  });

  it("should retry a failing reaction and then block", async () => {
    await store.commit("s", [{ name: "E", data: {} }], {
      correlation: "c",
      causation: {},
    });

    registry.events.E.reactions = new Map([
      [
        "handler",
        {
          handler: vi.fn().mockRejectedValue(new Error("fail")),
          resolver: () => "s",
          options: { maxRetries: 1, blockOnError: true, retryDelayMs: 0 },
        },
      ],
    ]);

    // First drain: should fail and increment retry
    await act.drain();

    // Second drain: should fail again, hit maxRetries, and block
    await act.drain();

    expect(fakeLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Retrying")
    );
    expect(fakeLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("Blocked")
    );
  });

  it("should log ValidationError specifically", async () => {
    await store.commit("s", [{ name: "E", data: {} }], {
      correlation: "c",
      causation: {},
    });

    registry.events.E.reactions = new Map([
      [
        "handler",
        {
          handler: vi
            .fn()
            .mockRejectedValue(
              new ValidationError("test-validation", {}, "details")
            ),
          resolver: () => "s",
          options: { maxRetries: 0, blockOnError: false, retryDelayMs: 0 },
        },
      ],
    ]);

    await act.drain();

    expect(fakeLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(ValidationError) }),
      "Invalid test-validation payload"
    );
  });

  it("should register and call an event listener", async () => {
    const committedPromise = new Promise<void>((resolve) => {
      act.on("committed", (snapshot: any) => {
        expect(snapshot.event.name).toBe("E");
        resolve();
      });
    });

    act.do("foo", { stream: "s", actor: { id: "a", name: "a" } }, {});
    await committedPromise;
  });

  it("should log error if handle promise rejects", async () => {
    vi.spyOn(act, "handle").mockRejectedValueOnce(new Error("handle failed"));
    await store.commit("s", [{ name: "E", data: {} }], {
      correlation: "c",
      causation: {},
    });
    registry.events.E.reactions = new Map([
      [
        "handler",
        {
          handler: vi.fn(),
          resolver: () => "s",
          options: { maxRetries: 0, blockOnError: false, retryDelayMs: 0 },
        },
      ],
    ]);

    await act.drain();

    expect(fakeLogger.error).toHaveBeenCalledWith(new Error("handle failed"));
  });

  it("should handle reaction handler throwing non-ValidationError", async () => {
    await store.commit("s", [{ name: "E", data: {} }], {
      correlation: "c",
      causation: {},
    });
    registry.events.E.reactions = new Map([
      [
        "handler",
        {
          handler: vi.fn().mockRejectedValue(new Error("fail")),
          resolver: () => "s",
          options: { maxRetries: 0, blockOnError: false, retryDelayMs: 0 },
        },
      ],
    ]);
    await act.drain();
    expect(fakeLogger.error).toHaveBeenCalledWith(new Error("fail"));
  });

  it("should block lease on blockOnError", async () => {
    await store.commit("s", [{ name: "E", data: {} }], {
      correlation: "c",
      causation: {},
    });
    registry.events.E.reactions = new Map([
      [
        "handler",
        {
          handler: vi
            .fn()
            .mockRejectedValue(new ValidationError("fail", {}, {})),
          resolver: () => "s",
          options: { maxRetries: 0, blockOnError: true, retryDelayMs: 0 },
        },
      ],
    ]);
    await act.drain();
    // Should log error and block
    expect(fakeLogger.error).toHaveBeenCalled();
  });

  it("should handle Promise.allSettled rejected in drain", async () => {
    // Patch act.handle to throw synchronously
    const origHandle = act["handle"];
    act["handle"] = vi.fn().mockRejectedValue(new Error("allSettled fail"));
    await store.commit("s", [{ name: "E", data: {} }], {
      correlation: "c",
      causation: {},
    });
    registry.events.E.reactions = new Map([
      [
        "handler",
        {
          handler: vi.fn(),
          resolver: () => "s",
          options: { maxRetries: 0, blockOnError: false, retryDelayMs: 0 },
        },
      ],
    ]);
    await act.drain();
    expect(fakeLogger.error).toHaveBeenCalledWith(new Error("allSettled fail"));
    act["handle"] = origHandle;
  });

  it("should handle drain with no events", async () => {
    // No events in store
    const result = await act.drain();
    expect(result).toBe(0);
  });

  it("should handle drain with no reactions for a stream", async () => {
    await store.commit("s", [{ name: "E", data: {} }], {
      correlation: "c",
      causation: {},
    });
    registry.events.E.reactions = new Map(); // No reactions
    const result = await act.drain();
    expect(result).toBe(0);
  });

  it("should call callback in load and handle errors", async () => {
    vi.resetModules(); // Ensure no lingering mocks
    const { Act } = await import("../src/act.js");
    const registry = { actions: {}, events: {} };
    const actInstance = new Act(registry, 1);
    const state = {
      name: "test",
      state: ZodEmpty,
      init: () => ({}),
      actions: {},
      events: {},
      patch: {},
      on: {},
    };
    const { store } = await import("../src/ports.js");
    await store().commit("stream", [{ name: "E", data: {} }], {
      correlation: "c",
      causation: {},
    });
    let called = false;
    await actInstance.load(state, "stream", () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it("should throw when calling do() with an invalid action", async () => {
    await expect(
      act.do("invalid", { stream: "s", actor: { id: "a", name: "a" } }, {})
    ).rejects.toThrow();
  });

  it("should return 0 and undefined for query with no matching events", async () => {
    const result = await act.query({ stream: "nonexistent" });
    expect(result.count).toBe(0);
    expect(result.first).toBeUndefined();
    expect(result.last).toBeUndefined();
  });

  it("should not call removed event listener", async () => {
    const listener = vi.fn();
    act.on("committed", listener);
    act.off("committed", listener);
    await act.do("foo", { stream: "s", actor: { id: "a", name: "a" } }, {});
    expect(listener).not.toHaveBeenCalled();
  });

  it("should handle unexpected error in reaction handler and continue", async () => {
    await store.commit("s", [{ name: "E", data: {} }], {
      correlation: "c",
      causation: {},
    });
    registry.events.E.reactions = new Map([
      [
        "handler",
        {
          handler: vi.fn().mockImplementation(() => {
            throw new Error("unexpected");
          }),
          resolver: () => "s",
          options: { maxRetries: 0, blockOnError: false, retryDelayMs: 0 },
        },
      ],
    ]);
    await expect(act.drain()).resolves.toBeGreaterThanOrEqual(0);
  });

  it("should drain with no listeners and no events", async () => {
    act = new (await import("../src/act.js")).Act(registry, 1);
    await expect(act.drain()).resolves.toBe(0);
  });

  it("should emit event with no listeners and return false", () => {
    const result = act.emit("nonexistent", {});
    expect(result).toBe(false);
  });

  it("should log error for non-ValidationError in lease handler", async () => {
    await store.commit("s", [{ name: "E", data: {} }], {
      correlation: "c",
      causation: {},
    });
    registry.events.E.reactions = new Map([
      [
        "handler",
        {
          handler: vi.fn().mockRejectedValue(new Error("not validation")),
          resolver: () => "s",
          options: { maxRetries: 0, blockOnError: false, retryDelayMs: 0 },
        },
      ],
    ]);
    await act.drain();
    expect(fakeLogger.error).toHaveBeenCalledWith(new Error("not validation"));
  });

  it("should log error for non-ValidationError (plain object) in lease handler", async () => {
    await store.commit("s", [{ name: "E", data: {} }], {
      correlation: "c",
      causation: {},
    });
    registry.events.E.reactions = new Map([
      [
        "handler",
        {
          handler: vi.fn().mockRejectedValue({ foo: "bar" }),
          resolver: () => "s",
          options: { maxRetries: 0, blockOnError: false, retryDelayMs: 0 },
        },
      ],
    ]);
    await act.drain();
    expect(fakeLogger.error).toHaveBeenCalledWith({ foo: "bar" });
  });

  it("should log error for non-ValidationError (string) in lease handler", async () => {
    await store.commit("s", [{ name: "E", data: {} }], {
      correlation: "c",
      causation: {},
    });
    registry.events.E.reactions = new Map([
      [
        "handler",
        {
          handler: vi.fn().mockRejectedValue("plain string error"),
          resolver: () => "s",
          options: { maxRetries: 0, blockOnError: false, retryDelayMs: 0 },
        },
      ],
    ]);
    await act.drain();
    expect(fakeLogger.error).toHaveBeenCalledWith("plain string error");
  });

  it("should log error when Promise.allSettled is rejected", async () => {
    vi.spyOn(Promise, "allSettled").mockRejectedValueOnce(
      new Error("allSettled failed")
    );
    await store.commit("s", [{ name: "E", data: {} }], {
      correlation: "c",
      causation: {},
    });
    registry.events.E.reactions = new Map([
      [
        "handler",
        {
          handler: vi.fn(),
          resolver: () => "s",
          options: { maxRetries: 0, blockOnError: false, retryDelayMs: 0 },
        },
      ],
    ]);

    await act.drain();

    expect(fakeLogger.error).toHaveBeenCalledWith(
      new Error("allSettled failed")
    );
  });

  it("should handle drain with event with no registered reactions", async () => {
    await store.commit("s", [{ name: "UNREGISTERED_EVENT", data: {} }], {
      correlation: "c",
      causation: {},
    });
    await act.drain();
    expect(fakeLogger.trace).toHaveBeenCalled();
  });
});
