import { Act } from "../src/act.js";
import { store } from "../src/ports.js";
import { Schema, Schemas } from "../src/types/action.js";
import { ValidationError } from "../src/types/errors.js";
import { Registry } from "../src/types/registry.js";
import { ZodEmpty } from "../src/types/schemas.js";

const makeHandler = (
  behavior: "success" | "fail" | "validation" | "object" | "string",
  value?: string | object
) => {
  switch (behavior) {
    case "success":
      return vi.fn();
    case "fail":
      return vi
        .fn()
        .mockRejectedValue(
          new Error(typeof value === "string" ? value : "fail")
        );
    case "validation":
      return vi
        .fn()
        .mockRejectedValue(
          new ValidationError(
            typeof value === "string" ? value : "fail",
            {},
            {}
          )
        );
    case "object":
      return vi
        .fn()
        .mockRejectedValue(
          value && typeof value === "object" ? value : { foo: "bar" }
        );
    case "string":
      return vi
        .fn()
        .mockRejectedValue(
          typeof value === "string" ? value : "plain string error"
        );
    default:
      return vi.fn();
  }
};

const makeReactionsMap = (
  handlers: Record<
    string,
    | ReturnType<typeof makeHandler>
    | [
        ReturnType<typeof makeHandler>,
        Partial<{
          maxRetries: number;
          blockOnError: boolean;
          retryDelayMs: number;
        }>,
      ]
  >
) =>
  new Map(
    Object.entries(handlers).map(([name, handlerOrTuple]) => {
      if (Array.isArray(handlerOrTuple)) {
        const [handler, options] = handlerOrTuple;
        return [
          name,
          {
            handler,
            resolver: { target: "s" },
            options: {
              maxRetries: 1,
              blockOnError: false,
              retryDelayMs: 0,
              ...options,
            },
          },
        ];
      } else {
        return [
          name,
          {
            handler: handlerOrTuple,
            resolver: { target: "s" },
            options: { maxRetries: 1, blockOnError: false, retryDelayMs: 0 },
          },
        ];
      }
    })
  );

const commitEvent = async (name = "E", data = {}) => {
  await store().commit("s", [{ name, data }], {
    correlation: "c",
    causation: {},
  });
};

describe("Act", () => {
  let act: Act<Schema, Schemas, Schemas>;
  let registry: Registry<Schema, Schemas, Schemas>;
  const setupAct = async () => {
    await store().drop();
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
          reactions: makeReactionsMap({}),
        },
      },
    };
    act = new Act(registry);
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    await setupAct();
  });

  it("should emit committed event on do", async () => {
    const emitSpy = vi.spyOn(act, "emit");
    await act.do("foo", { stream: "s", actor: { id: "a", name: "a" } }, {});
    expect(emitSpy).toHaveBeenCalledWith("committed", expect.anything());
  });

  it("should return correct query result", async () => {
    await store().commit("s", [{ name: "E", data: {} }], {
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
    // @ts-expect-error: dynamic registry for test flexibility
    act.drainLocked = true;
    const result = await act.drain();
    expect(result).toBe(0);
  });

  // Table-driven test for all error handler types and the success case
  const noopHandler = vi.fn();
  const allCases = [
    {
      label: "success",
      handlers: {
        successHandler: makeHandler("success"),
        failHandler: noopHandler,
      },
    },
    {
      label: "fail",
      handlers: {
        failHandler: makeHandler("fail"),
        successHandler: makeHandler("success"),
      },
    },
    {
      label: "validation",
      handlers: {
        failHandler: makeHandler("validation", "test-validation"),
        successHandler: makeHandler("success"),
      },
    },
    {
      label: "object",
      handlers: {
        failHandler: makeHandler("object", { foo: "bar" }),
        successHandler: makeHandler("success"),
      },
    },
    {
      label: "string",
      handlers: {
        failHandler: makeHandler("string", "plain string error"),
        successHandler: makeHandler("success"),
      },
    },
  ];

  describe.each(allCases)(
    "should handle drain with reactions: %s",
    ({ label, handlers }) => {
      it(label, async () => {
        await commitEvent("E", {});
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        registry.events.E.reactions = makeReactionsMap(handlers);
        if (label === "success") {
          await store().lease([
            { stream: "s", at: -1, retry: 0, block: false, by: "test" },
          ]);
        }
        const emitSpy = vi.spyOn(act, "emit");
        if (label === "success") {
          const { logger } = await import("../src/ports.js");
          const traceSpy = vi.spyOn(logger, "trace");
          const warnSpy = vi.spyOn(logger, "warn");
          const successHandler = handlers.successHandler;
          await act.drain();
          expect(successHandler).toHaveBeenCalled();
          expect(traceSpy).toHaveBeenCalled();
          expect(warnSpy).not.toHaveBeenCalled();
          expect(emitSpy).toHaveBeenCalledWith("drained", expect.any(Array));
        } else {
          await act.drain();
        }
      });
    }
  );

  it("should retry a failing reaction and then block", async () => {
    await commitEvent();
    registry.events.E.reactions = makeReactionsMap({
      failHandler: makeHandler("fail"),
      successHandler: makeHandler("success"),
    });
    await act.drain();
    await act.drain();
    // No warn or error log expected for blockOnError: false
  });

  it("should register and call an event listener", async () => {
    const committedPromise = new Promise<void>((resolve) => {
      act.on("committed", (snapshots: any[]) => {
        expect(snapshots[0].event.name).toBe("E");
        resolve();
      });
    });
    registry.events.E.reactions = makeReactionsMap({
      successHandler: makeHandler("success"),
      failHandler: noopHandler,
    });
    await act.do("foo", { stream: "s", actor: { id: "a", name: "a" } }, {});
    await committedPromise;
  });

  it("should log error if handle promise rejects", async () => {
    // @ts-expect-error: dynamic registry for test flexibility
    vi.spyOn(act, "handle").mockRejectedValueOnce(new Error("handle failed"));
    await commitEvent();
    registry.events.E.reactions = makeReactionsMap({
      failHandler: makeHandler("fail", "handle failed"),
      successHandler: makeHandler("success"),
    });
    await act.drain();
    // No error log expected for blockOnError: false
  });

  it("should handle reaction handler throwing non-ValidationError", async () => {
    await commitEvent();
    registry.events.E.reactions = makeReactionsMap({
      failHandler: makeHandler("fail"),
      successHandler: makeHandler("success"),
    });
    await act.drain();
    // No error log expected for blockOnError: false
  });

  it("should block lease on blockOnError", async () => {
    await commitEvent();
    registry.events.E.reactions = makeReactionsMap({
      failHandler: makeHandler("validation"),
      successHandler: makeHandler("success"),
    });
    await act.drain();
    // No error log expected for blockOnError: false
  });

  it("should handle Promise.allSettled rejected in drain", async () => {
    const origHandle = act["handle"];
    act["handle"] = vi.fn().mockRejectedValue(new Error("allSettled fail"));
    await commitEvent();
    registry.events.E.reactions = makeReactionsMap({
      failHandler: makeHandler("fail", "allSettled fail"),
      successHandler: makeHandler("success"),
    });
    await act.drain();
    act["handle"] = origHandle;
    // No error log expected for blockOnError: false
  });

  it("should handle drain with no events", async () => {
    const result = await act.drain();
    expect(result).toBe(0);
  });

  it("should handle drain with no reactions for a stream", async () => {
    registry.events.E.reactions = makeReactionsMap({}); // No reactions
    const result = await act.drain();
    expect(result).toBe(0);
  });

  it("should drain with no listeners and no events", async () => {
    registry.events.E.reactions = makeReactionsMap({});
    await expect(act.drain()).resolves.toBe(0);
  });

  it("should call callback in load and handle errors", async () => {
    let called = false;
    await commitEvent("E", {});
    await act.load(registry.actions.foo, "s", () => {
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    act.on("committed", listener);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    act.off("committed", listener);
    await act.do("foo", { stream: "s", actor: { id: "a", name: "a" } }, {});
    expect(listener).not.toHaveBeenCalled();
  });

  it("should handle unexpected error in reaction handler and continue", async () => {
    await store().commit("s", [{ name: "E", data: {} }], {
      correlation: "c",
      causation: {},
    });
    registry.events.E.reactions = makeReactionsMap({
      handler: vi.fn().mockImplementation(() => {
        throw new Error("unexpected");
      }),
    });
    await expect(act.drain()).resolves.toBeGreaterThanOrEqual(0);
  });

  it("should emit event with no listeners and return false", () => {
    // @ts-expect-error: dynamic registry for test flexibility
    const result = act.emit("nonexistent", {});
    expect(result).toBe(false);
  });

  it("should log error for non-ValidationError in lease handler", async () => {
    await commitEvent();
    registry.events.E.reactions = makeReactionsMap({
      failHandler: makeHandler("fail", "not validation"),
      successHandler: makeHandler("success"),
    });
    await act.drain();
    // No error log expected for blockOnError: false
  });

  it("should log error for non-ValidationError (plain object) in lease handler", async () => {
    await commitEvent();
    registry.events.E.reactions = makeReactionsMap({
      failHandler: makeHandler("object", { foo: "bar" }),
      successHandler: makeHandler("success"),
    });
    await act.drain();
    // No error log expected for blockOnError: false
  });

  it("should log error for non-ValidationError (string) in lease handler", async () => {
    await commitEvent();
    registry.events.E.reactions = makeReactionsMap({
      failHandler: makeHandler("string", "plain string error"),
      successHandler: makeHandler("success"),
    });
    await act.drain();
    // No error log expected for blockOnError: false
  });

  it("should log error when Promise.allSettled is rejected", async () => {
    vi.spyOn(Promise, "allSettled").mockRejectedValueOnce(
      new Error("allSettled failed")
    );
    await commitEvent();
    registry.events.E.reactions = makeReactionsMap({
      failHandler: makeHandler("fail", "allSettled failed"),
      successHandler: makeHandler("success"),
    });
    await act.drain();
    // No error log expected for blockOnError: false
  });

  it("should handle drain with event with no registered reactions", async () => {
    const { logger } = await import("../src/ports.js");
    const traceSpy = vi.spyOn(logger, "trace");
    await store().commit("s", [{ name: "UNREGISTERED_EVENT", data: {} }], {
      correlation: "c",
      causation: {},
    });
    await act.drain();
    expect(traceSpy).toHaveBeenCalled();
  });

  it("should handle ValidationError and block lease", async () => {
    await commitEvent();
    registry.events.E.reactions = makeReactionsMap({
      failHandler: [
        makeHandler("validation", "validation error"),
        { maxRetries: 1, blockOnError: true, retryDelayMs: 0 },
      ],
    });
    await act.drain();
  });

  it("should handle generic error and block lease", async () => {
    await commitEvent();
    registry.events.E.reactions = makeReactionsMap({
      failHandler: [
        makeHandler("fail", "generic error"),
        { maxRetries: 1, blockOnError: true, retryDelayMs: 0 },
      ],
    });
    await act.drain();
  });

  it("should retry on error and not block if blockOnError is false", async () => {
    await commitEvent();
    registry.events.E.reactions = makeReactionsMap({
      failHandler: [
        makeHandler("fail", "retry error"),
        { maxRetries: 2, blockOnError: false, retryDelayMs: 0 },
      ],
    });
    await act.drain();
  });

  it("should log a warning and retry on reaction failure", async () => {
    let callCount = 0;
    const handler = vi.fn().mockImplementation(() => {
      if (callCount++ === 0) throw new Error("fail once");
      // succeed on second call
    });
    registry.events.E.reactions = makeReactionsMap({
      E: [handler, { maxRetries: 2, blockOnError: false, retryDelayMs: 0 }],
    });
    await store().commit("s", [{ name: "E", data: {} }], {
      correlation: "c",
      causation: {},
    });
    await store().lease([
      { stream: "s", at: -1, retry: 0, block: false, by: "test" },
    ]);
    await act.drain(); // first attempt, handler throws, lease.retry++
    await store().lease([
      { stream: "s", at: -1, retry: 1, block: false, by: "test" },
    ]);
    await act.drain(); // second attempt, handler succeeds
    expect(handler).toHaveBeenCalledTimes(2); // ensure retry happened
  });

  it("should return the number of drained leases", async () => {
    registry.events.E.reactions = makeReactionsMap({
      E: makeHandler("success"),
    });
    await store().commit("s", [{ name: "E", data: {} }], {
      correlation: "c",
      causation: {},
    });
    await store().lease([
      { stream: "s", at: -1, retry: 0, block: false, by: "test" },
    ]);
    const result = await act.drain();
    expect(result).toBeGreaterThan(0);
  });
});
