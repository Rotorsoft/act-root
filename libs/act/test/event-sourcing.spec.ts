import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { InMemoryStore } from "../src/adapters/InMemoryStore.js";
import { action, load, snap } from "../src/event-sourcing.js";
import { dispose, logger, SNAP_EVENT, store } from "../src/ports.js";
import { state } from "../src/state-builder.js";
import { InvariantError } from "../src/types/errors.js";

// Minimal state machine mock
const me = state("me", z.object({ count: z.number() }))
  .init(() => ({ count: 0 }))
  .emits({
    INCREMENT: z.object({ by: z.number() }),
    SNAP_EVENT: z.object({ count: z.number() }),
  })
  .patch({
    INCREMENT: (event, state) => ({ count: state.count + event.data.by }),
    SNAP_EVENT: (event) => event.data,
  })
  .on("increment", z.object({ count: z.number() }))
  .given([
    {
      valid: () => false,
      description: "should fail invariant",
    },
  ])
  .emit((action) => ["INCREMENT", { by: action.count }])
  .build();

describe("event-sourcing", () => {
  beforeEach(() => {
    store(new InMemoryStore());
    vi.spyOn(logger, "error");
    vi.spyOn(logger, "trace");
  });

  afterEach(async () => {
    await dispose()();
    vi.restoreAllMocks();
  });

  it("should call logger.error on snap error", async () => {
    vi.spyOn(store(), "commit").mockRejectedValueOnce(new Error("fail"));
    await snap({
      event: {
        id: 1,
        stream: "s",
        name: "INCREMENT",
        version: 1,
        created: new Date(),
        data: {},
        meta: { correlation: "c", causation: {} },
      },
      state: {},
      patches: 0,
      snaps: 0,
    });
    expect(logger.error).toHaveBeenCalled();
  });

  it("should call logger.trace on snap success", async () => {
    // First, commit a real event to get a valid payload for snap
    const committed = await store().commit(
      "s",
      [{ name: "INCREMENT", data: { by: 1 } }],
      { correlation: "c", causation: {} }
    );

    await snap({
      event: committed[0],
      state: { count: 1 },
      patches: 1,
      snaps: 0,
    });
    expect(logger.trace).toHaveBeenCalled();
    const events: any[] = [];
    await store().query((e) => events.push(e));
    // The original event is [0], the snap event is [1]
    expect(events[1].name).toBe(SNAP_EVENT);
    expect(events[1].data.count).toBe(1);
  });

  it("should load from a snapshot event", async () => {
    const s = store();
    await s.commit("s", [{ name: SNAP_EVENT, data: { count: 100 } }], {
      correlation: "c",
      causation: {},
    });
    await s.commit("s", [{ name: "INCREMENT", data: { by: 1 } }], {
      correlation: "c",
      causation: {},
    });

    const snapshot = await load(me, "s");
    expect(snapshot.state.count).toBe(101);
    expect(snapshot.snaps).toBe(1);
    expect(snapshot.patches).toBe(1);
  });

  it("should throw on action invariant failure", async () => {
    await expect(
      action(
        me,
        "increment",
        { stream: "s", actor: { id: "a", name: "a" } },
        { count: 1 }
      )
    ).rejects.toThrow(InvariantError);
  });

  it("should throw on action missing stream", async () => {
    // @ts-expect-error missing stream
    await expect(action(me, "increment", {}, {})).rejects.toThrow(
      "Missing target stream"
    );
  });

  it("should return snapshot if result is falsy", async () => {
    const me2 = { ...me, on: { increment: () => undefined }, given: undefined };
    const result = await action(
      me2,
      "increment",
      { stream: "s", actor: { id: "a", name: "a" } },
      { count: 1 }
    );
    expect(result).toBeDefined();
  });

  it("should handle action reacting to an event", async () => {
    const reactingTo = {
      id: 123,
      name: "OriginalEvent",
      stream: "orig-stream",
      data: {},
      meta: { correlation: "test-correlation", causation: {} },
      version: 1,
      created: new Date(),
    };

    await action(
      { ...me, given: undefined },
      "increment",
      { stream: "s", actor: { id: "a", name: "a" } },
      { count: 1 },
      reactingTo
    );

    const events: any[] = [];
    await store().query((e) => events.push(e), { stream: "s" });
    expect(events[0].meta.correlation).toBe("test-correlation");
    expect(events[0].meta.causation.event?.id).toBe(123);
  });

  it("should call snap function when it returns true", async () => {
    const snapFn = vi.fn().mockReturnValue(true);
    const meWithSnap = { ...me, snap: snapFn, given: undefined };

    await action(
      meWithSnap,
      "increment",
      { stream: "s", actor: { id: "a", name: "a" } },
      { count: 1 }
    );

    expect(snapFn).toHaveBeenCalled();
    const events: any[] = [];
    await store().query((e) => events.push(e), { stream: "s" });
    // first the action event, then the snap event
    expect(events.length).toBe(2);
    expect(events[1].name).toBe(SNAP_EVENT);
  });

  it("should handle action that produces no event", async () => {
    const meWithoutEmit = {
      ...me,
      on: { increment: () => undefined },
      given: undefined,
    };
    const snapshot = await action(
      meWithoutEmit,
      "increment",
      { stream: "s", actor: { id: "a", name: "a" } },
      { count: 1 }
    );
    expect(snapshot.event).toBeUndefined();
    expect(snapshot.state.count).toBe(0); // initial state
  });

  it("should throw when commit fails in action", async () => {
    vi.spyOn(store(), "commit").mockRejectedValueOnce(
      new Error("Commit failed")
    );
    await expect(
      action(
        { ...me, given: undefined },
        "increment",
        { stream: "s", actor: { id: "a", name: "a" } },
        { count: 1 }
      )
    ).rejects.toThrow("Commit failed");
  });

  it("should skip validation when flag is true", async () => {
    const validateSpy = vi.spyOn(me.actions.increment, "parse");
    await action(
      { ...me, given: undefined },
      "increment",
      { stream: "s", actor: { id: "a", name: "a" } },
      { count: "invalid" } as unknown as { count: number }, // invalid payload
      undefined,
      true // skipValidation = true
    );
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it("should handle loading a state with no init function", async () => {
    const meWithoutInit = { ...me, init: undefined };
    // @ts-expect-error - testing missing init
    const snapshot = await load(meWithoutInit, "s");
    expect(snapshot.state).toEqual({});
  });

  it("should handle loading a stream with no events", async () => {
    const snapshot = await load(me, "s-empty");
    expect(snapshot.state.count).toBe(0);
    expect(snapshot.patches).toBe(0);
  });

  it("should call the load callback for each event", async () => {
    const s = store();
    await s.commit("s", [{ name: "INCREMENT", data: { by: 1 } }], {
      correlation: "c",
      causation: {},
    });
    await s.commit("s", [{ name: "INCREMENT", data: { by: 2 } }], {
      correlation: "c",
      causation: {},
    });

    const callback = vi.fn();
    await load(me, "s", callback);

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback.mock.calls[0][0].state.count).toBe(1);
    expect(callback.mock.calls[1][0].state.count).toBe(3);
  });

  it("should handle an action with no specific invariants", async () => {
    const meWithOtherInvariants = {
      ...me,
      given: { increment: [] },
    };
    // Should not throw InvariantError because 'increment' has no invariants
    const snapshot = await action(
      meWithOtherInvariants,
      "increment",
      { stream: "s", actor: { id: "a", name: "a" } },
      { count: 1 }
    );
    expect(snapshot.event?.name).toBe("INCREMENT");
  });

  it("should handle action handler returning an empty array", async () => {
    const meWithEmptyArray = {
      ...me,
      on: { increment: () => [] },
      given: undefined,
    };
    const commitSpy = vi.spyOn(store(), "commit");
    await action(
      meWithEmptyArray,
      "increment",
      { stream: "s", actor: { id: "a", name: "a" } },
      { count: 1 }
    );
    expect(commitSpy).not.toHaveBeenCalled();
  });

  it("should use snapshot event version for commit", async () => {
    // Commit an event to establish a version number
    await store().commit("s", [{ name: "INCREMENT", data: { by: 1 } }], {
      correlation: "c",
      causation: {},
    });

    const commitSpy = vi.spyOn(store(), "commit");

    await action(
      { ...me, given: undefined },
      "increment",
      { stream: "s", actor: { id: "a", name: "a" } },
      { count: 1 }
      // no reactingTo, no expectedVersion
    );

    expect(commitSpy).toHaveBeenCalledWith(
      "s",
      expect.any(Array),
      expect.any(Object),
      0 // expectedVersion from snapshot.event.version
    );
  });
});
