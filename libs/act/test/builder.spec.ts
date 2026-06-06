import { z } from "zod";
import { type Actor, act, dispose, state, ZodEmpty } from "../src/index.js";

const A1 = state({ A1: z.object({}) })
  .init(() => ({}))
  .emits({ Event1: z.object({}), Event2: z.object({}) })
  .patch({ Event1: () => ({}), Event2: () => ({}) })
  .on({ Act1: z.object({}) })
  .emit(() => ["Event1", {}])
  .on({ Act2: z.object({}) })
  .emit(() => ["Event2", {}])
  .build();

const A2 = state({ A2: ZodEmpty })
  .init(() => ({}))
  .emits({ Event22: ZodEmpty })
  .patch({ Event22: () => ({}) })
  .on({ Act1: ZodEmpty })
  .emit(() => ["Event22", {}])
  .build();

const A3 = state({ A3: ZodEmpty })
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
      .withState(A1)
      .on("Event1")
      .do(function handleEvent1() {
        return Promise.resolve();
      })
      .to("abc")
      .on("Event2")
      .do(function handleEvent2() {
        return Promise.resolve();
      })
      .to("def")
      .build();

    const result = await app.do("Act1", { stream: "A", actor }, {});
    expect(result).toBeDefined();
  });

  it("should throw duplicate action", () => {
    const builder = act().withState(A1);
    expect(() => builder.withState(A2)).toThrow('Duplicate action "Act1"');
  });

  it("should throw duplicate event", () => {
    const builder = act().withState(A1);
    expect(() => builder.withState(A3)).toThrow('Duplicate event "Event1"');
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
      view: (e: any) => e,
      message: (v: any) => v,
    };
    const state2 = {
      name: "foo2",
      state: ZodEmpty,
      init: () => ({}),
      actions: { a: ZodEmpty },
      events: { e: ZodEmpty },
      patch: { e: () => ({}) },
      on: { a: () => ["e", {}] as [string, object] },
      view: (e: any) => e,
      message: (v: any) => v,
    };
    builder.withState(state1);
    expect(() => builder.withState(state2)).toThrow("Duplicate action");
  });

  it("should throw for anonymous handlers in act builder", () => {
    expect(() =>
      act()
        .withState(A1)
        .on("Event1")
        .do(async () => {})
    ).toThrow('Reaction handler for "Event1" must be a named function');
  });

  it("should allow chaining .on().do().to()", () => {
    const app = act()
      .withState(A1)
      .on("Event1")
      .do(function handleEvent1() {
        return Promise.resolve();
      })
      .to("custom")
      .on("Event2")
      .do(function handleEvent2() {
        return Promise.resolve();
      })
      .to("other")
      .build();
    expect(app).toBeDefined();
  });

  it("should execute a reaction with a custom resolver using .to()", () => {
    const testState = state({ S2: z.object({}) })
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
      .withState(testState)
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
    const builder = act().withState(A1).on("Event1").do(defaultHandler);

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
    const builder = act().withState(A1).on("Event1").do(optHandler, {
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
      view: (e: any) => e,
      message: (v: any) => v,
    };
    const s2 = {
      name: "NonObj",
      state: z.any(),
      init: () => ({}),
      actions: { nonB: ZodEmpty },
      events: { nonE2: ZodEmpty },
      patch: { nonE2: () => ({}) },
      on: { nonB: () => ["nonE2", {}] as [string, object] },
      view: (e: any) => e,
      message: (v: any) => v,
    };
    const builder = act();
    builder.withState(s1);
    expect(() => builder.withState(s2)).not.toThrow();
  });

  it("should allow multiple reactions for the same event with different handlers", () => {
    function handlerA() {
      return Promise.resolve();
    }
    function handlerB() {
      return Promise.resolve();
    }
    const builder = act()
      .withState(A1)
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

  // Compile-time evidence that the act() fluent chain preserves type
  // narrowing for action names, payloads, and event names through every
  // .withState() / .withSlice() / .on() call. These tests don't assert
  // runtime behavior — they fail at compile time if narrowing breaks.
  /* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/require-await -- type-only narrowing checks */
  describe("type narrowing", () => {
    const Counter = state({ Counter: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({
        Incremented: z.object({ by: z.number() }),
      })
      .patch({
        Incremented: ({ data }, s) => {
          // patch handler: event.data narrowed to {by:number},
          // state narrowed to {count:number}
          const _by: number = data.by;
          const _count: number = s.count;
          return { count: s.count + data.by };
        },
      })
      .on({ increment: z.object({ amount: z.number() }) })
      .given([
        // given handler: state narrowed to {count:number}
        {
          valid: (s) => s.count >= 0,
          description: "non-negative",
        },
      ])
      .emit((action) => ["Incremented", { by: action.amount }])
      .snap((snap) => snap.patches >= 10)
      .build();

    // Type-only checks: the inner functions are constructed (so TS
    // checks them) but never invoked, so @ts-expect-error directives
    // can flag invalid payloads/names without triggering runtime errors.

    it("narrows action.do() payload type at the call site", () => {
      const _check = () => {
        const app = act().withState(Counter).build();
        const actor: Actor = { id: "u", name: "u" };
        // The 3rd arg is narrowed to {amount:number} from .on({increment:...})
        void app.do("increment", { stream: "s", actor }, { amount: 5 });
        // @ts-expect-error 'wrongField' isn't on the increment payload
        void app.do("increment", { stream: "s", actor }, { wrongField: 5 });
      };
      expect(typeof _check).toBe("function");
    });

    it("rejects unknown action names in app.do() at compile time", () => {
      const _check = () => {
        const app = act().withState(A1).build();
        const actor: Actor = { id: "u", name: "u" };
        // @ts-expect-error 'NotARegisteredAction' isn't in A1.actions
        void app.do("NotARegisteredAction", { stream: "s", actor }, {});
      };
      expect(typeof _check).toBe("function");
    });

    it("rejects unknown event names in .on() at compile time", () => {
      const _check = () => {
        const builder = act().withState(A1);
        // @ts-expect-error 'NotAnEvent' isn't in A1.events
        builder.on("NotAnEvent");
      };
      expect(typeof _check).toBe("function");
    });

    it("narrows reaction handler event + scoped app at the call site", () => {
      // This builder is constructed but not exercised at runtime — the
      // narrowing checks happen at compile time through the @ts-expect-error.
      act()
        .withState(Counter)
        .on("Incremented")
        .do(async function react(event, _stream, _app) {
          // event.data narrowed to {by:number}
          const by: number = event.data.by;
          expect(by).toBeDefined();
        })
        .to("counter-target")
        .build();

      // Compile-time only: scoped app rejects unknown action names.
      // (Inside a function we never call, so no runtime error.)
      const _typeCheck = (_event: unknown) =>
        act()
          .withState(Counter)
          .on("Incremented")
          .do(async function react2(_e, _s, app) {
            const actor: Actor = { id: "u", name: "u" };
            // valid action
            void app.do("increment", { stream: "x", actor }, { amount: 1 });
            // @ts-expect-error unknown action via scoped app
            void app.do("nope", { stream: "x", actor }, {});
          })
          .to("counter-target");

      expect(true).toBe(true);
    });

    it("narrows app.load result state shape at the call site", async () => {
      const app = act().withState(Counter).build();
      const snap = await app.load(Counter, "s");
      // snap.state narrowed to {count:number}
      const _count: number = snap.state.count;
      expect(_count).toBe(0);
    });
  });
});
