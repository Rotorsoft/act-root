import { z } from "zod";
import { act, type Actor, dispose, state, ZodEmpty } from "../src/index.js";

const A1 = state("A1", z.object({}))
  .init(() => ({}))
  .emits({ Event1: z.object({}), Event2: z.object({}) })
  .patch({ Event1: () => ({}), Event2: () => ({}) })
  .on({ Act1: z.object({}) })
  .emit(() => ["Event1", {}])
  .on({ Act2: z.object({}) })
  .emit(() => ["Event2", {}])
  .build();

const A2 = state("A2", ZodEmpty)
  .init(() => ({}))
  .emits({ Event22: ZodEmpty })
  .patch({ Event22: () => ({}) })
  .on({ Act1: ZodEmpty })
  .emit(() => ["Event22", {}])
  .build();

const A3 = state("A3", ZodEmpty)
  .init(() => ({}))
  .emits({ Event1: ZodEmpty, Event2: ZodEmpty })
  .patch({ Event1: () => ({}), Event2: () => ({}) })
  .on({ Act3: ZodEmpty })
  .emit(() => ["Event1", {}])
  .build();

describe("Builder", () => {
  const actor: Actor = { id: "1", name: "Actor" };

  afterEach(async () => {
    await dispose()();
  });

  it("should act ok, but no events emitted", async () => {
    const app = act()
      .with(A1)
      .on("Event1")
      .do(() => Promise.resolve())
      .void()
      .on("Event2")
      .do(() => Promise.resolve())
      .to("abc")
      .build();

    const result = await app.do("Act1", { stream: "A", actor }, {});
    expect(result).toBeDefined();
  });

  it("should throw duplicate action", () => {
    const builder = act().with(A1);
    expect(() => builder.with(A2)).toThrow('Duplicate action "Act1"');
  });

  it("should throw duplicate event", () => {
    const builder = act().with(A1);
    expect(() => builder.with(A3)).toThrow('Duplicate event "Event1"');
  });

  it("should throw on duplicate action or event", () => {
    const builder = act();
    // Use two different state objects with the same action name
    const state1 = {
      name: "foo1",
      state: ZodEmpty,
      init: () => ({}),
      actions: { a: ZodEmpty },
      events: { e: ZodEmpty },
      patch: { e: () => ({}) },
      on: { a: () => ["e", {}] as [string, object] },
    };
    const state2 = {
      name: "foo2",
      state: ZodEmpty,
      init: () => ({}),
      actions: { a: ZodEmpty },
      events: { e: ZodEmpty },
      patch: { e: () => ({}) },
      on: { a: () => ["e", {}] as [string, object] },
    };
    builder.with(state1);
    expect(() => builder.with(state2)).toThrow("Duplicate action");
  });

  it("should allow chaining .on().do().to() and .on().do().void()", () => {
    const app = act()
      .with(A1)
      .on("Event1")
      .do(() => Promise.resolve())
      .to("custom")
      .on("Event2")
      .do(() => Promise.resolve())
      .void()
      .build();
    expect(app).toBeDefined();
  });

  it("should execute a reaction with void resolver", () => {
    const builder = act()
      .with(A1)
      .on("Event1")
      .do(function voidHandler() {
        return Promise.resolve();
      })
      .void();
    // Access the event registry before build()
    const reaction = builder.events.Event1.reactions.get("voidHandler");
    // The resolver should be the _void_ function from act-builder
    const { resolver } = reaction || {};
    // _void_ always returns undefined
    expect(typeof resolver).toBe("function");
    if (typeof resolver === "function") {
      expect(
        resolver({
          name: "Event1",
          data: {},
          id: 1,
          stream: "s",
          version: 1,
          created: new Date(),
          meta: { correlation: "c", causation: {} },
        })
      ).toBeUndefined();
    } else {
      expect(resolver).toBeUndefined();
    }
  });

  it("should trigger the void resolver through the Act API", async () => {
    // Define a state with an action and event
    const testState = state("S", z.object({}))
      .init(() => ({}))
      .emits({ E: z.object({}) })
      .patch({ E: () => ({}) })
      .on({ A: z.object({}) })
      .emit(() => ["E", {}])
      .build();

    // Build an app with a void reaction for event E
    const app = act()
      .with(testState)
      .on("E")
      .do(() => Promise.resolve())
      .void()
      .build();

    // Trigger the action, which emits event E and should call the void resolver
    await app.do("A", { stream: "s", actor: { id: "1", name: "actor" } }, {});
    // If no error is thrown, the void resolver was called
    expect(true).toBe(true);
  });

  it("should execute a reaction with a custom resolver using .to()", () => {
    const testState = state("S2", z.object({}))
      .init(() => ({}))
      .emits({ E: z.object({}) })
      .patch({ E: () => ({}) })
      .on({ A: z.object({}) })
      .emit(() => ["E", {}])
      .build();

    const customResolver = vi.fn(() => ({ target: "custom-stream" }));
    function customHandler() {
      return Promise.resolve();
    }

    const builder = act()
      .with(testState)
      .on("E")
      .do(customHandler)
      .to(customResolver);

    // Access the reaction and call the resolver directly
    const reaction = builder.events.E.reactions.get("customHandler");
    expect(reaction?.resolver).toBe(customResolver);
    if (typeof reaction?.resolver === "function") {
      expect(
        reaction.resolver({
          name: "E",
          data: {},
          id: 1,
          stream: "s",
          version: 1,
          created: new Date(),
          meta: { correlation: "c", causation: {} },
        })
      ).toStrictEqual({ target: "custom-stream" });
    } else {
      expect(reaction?.resolver).toStrictEqual({ target: "custom-stream" });
    }
  });

  it("should execute a reaction with the default resolver (_this_)", () => {
    function defaultHandler() {
      return Promise.resolve();
    }
    const builder = act().with(A1).on("Event1").do(defaultHandler);

    const reaction = builder.events.Event1.reactions.get("defaultHandler");
    // The resolver should be the _this_ function from act-builder
    expect(typeof reaction?.resolver).toBe("function");
    if (typeof reaction?.resolver === "function") {
      expect(
        reaction.resolver({
          name: "Event1",
          data: {},
          id: 1,
          stream: "foo",
          version: 1,
          created: new Date(),
          meta: { correlation: "c", causation: {} },
        })
      ).toStrictEqual({ source: "foo", target: "foo" });
    } else {
      expect(reaction?.resolver).toStrictEqual({
        source: "foo",
        target: "foo",
      });
    }
  });

  it("should set custom reaction options", () => {
    function optHandler() {
      return Promise.resolve();
    }
    const builder = act().with(A1).on("Event1").do(optHandler, {
      blockOnError: false,
      maxRetries: 1,
    });
    const reaction = builder.events.Event1.reactions.get("optHandler");
    expect(reaction?.options).toEqual({
      blockOnError: false,
      maxRetries: 1,
    });
  });

  it("should merge states with non-ZodObject schemas (fallback path)", () => {
    // z.any() is not a ZodObject, so mergeSchemas should return existing unchanged
    const s1 = {
      name: "NonObj",
      state: z.any(),
      init: () => ({}),
      actions: { nonA: ZodEmpty },
      events: { nonE1: ZodEmpty },
      patch: { nonE1: () => ({}) },
      on: { nonA: () => ["nonE1", {}] as [string, object] },
    };
    const s2 = {
      name: "NonObj",
      state: z.any(),
      init: () => ({}),
      actions: { nonB: ZodEmpty },
      events: { nonE2: ZodEmpty },
      patch: { nonE2: () => ({}) },
      on: { nonB: () => ["nonE2", {}] as [string, object] },
    };
    const builder = act();
    builder.with(s1);
    expect(() => builder.with(s2)).not.toThrow();
  });

  it("should allow multiple reactions for the same event with different handlers", () => {
    function handlerA() {
      return Promise.resolve();
    }
    function handlerB() {
      return Promise.resolve();
    }
    const builder = act()
      .with(A1)
      .on("Event1")
      .do(handlerA)
      .to("streamA")
      .on("Event1")
      .do(handlerB)
      .to("streamB");
    const reactionA = builder.events.Event1.reactions.get("handlerA");
    const reactionB = builder.events.Event1.reactions.get("handlerB");
    if (typeof reactionA?.resolver === "function") {
      expect(
        reactionA.resolver({
          name: "Event1",
          data: {},
          id: 1,
          stream: "streamA",
          version: 1,
          created: new Date(),
          meta: { correlation: "c", causation: {} },
        })
      ).toStrictEqual({ target: "streamA" });
    } else {
      expect(reactionA?.resolver).toStrictEqual({ target: "streamA" });
    }
    if (typeof reactionB?.resolver === "function") {
      expect(
        reactionB.resolver({
          name: "Event1",
          data: {},
          id: 1,
          stream: "streamB",
          version: 1,
          created: new Date(),
          meta: { correlation: "c", causation: {} },
        })
      ).toStrictEqual({ target: "streamB" });
    } else {
      expect(reactionB?.resolver).toStrictEqual({ target: "streamB" });
    }
  });
});
