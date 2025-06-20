import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "../src/adapters/InMemoryStore.js";
import { ValidationError } from "../src/types/errors.js";
import type { Registry } from "../src/types/registry.js";
import { ZodEmpty } from "../src/types/schemas.js";

const fakeLogger = {
  trace: vi.fn(),
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

describe("Act coverage", () => {
  let act: any; // type any because of dynamic import
  let registry: Registry<any, any, any>;

  beforeEach(async () => {
    vi.clearAllMocks();
    fakeLogger.trace.mockClear();
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
    expect(fakeLogger.error).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith("drained", expect.any(Array));
  });

  it("should handle drain with reaction error and block", async () => {
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

    expect(fakeLogger.error).toHaveBeenCalledWith(
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
});
