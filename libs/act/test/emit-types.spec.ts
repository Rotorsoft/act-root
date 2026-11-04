/**
 * What the editor says about an action declaration. These run in the
 * type-checker (`pnpm typecheck`). `@ts-expect-error` covers only the next
 * line, so each one also pins where the mistake is marked: if errors move back
 * to the word `emit`, the directive goes unused and the typecheck fails.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { state, ZodEmpty } from "../src/index.js";

const AgentLoad = state({ AgentLoad: z.object({ open: z.number() }) })
  .init(() => ({ open: 0 }))
  .emits({
    Taken: z.object({
      at: z.number(),
      by: z.object({ id: z.string() }).optional(),
    }),
    Dropped: ZodEmpty,
  })
  .build();

const Move = z.object({ agent: z.string() });
const ticket = () =>
  state({ Ticket: z.object({ agent: z.string().optional() }) })
    .init(() => ({}))
    .emits({
      Moved: Move,
      Tagged: z.object({ tags: z.array(z.object({ t: z.string() })) }),
      Open: z.object({ meta: z.unknown(), any: z.any() }),
      Dated: z.object({
        at: z.date(),
        pair: z.tuple([z.number(), z.string()]),
      }),
      Contacted: z.union([
        z.object({ kind: z.literal("a"), a: z.string() }),
        z.object({ kind: z.literal("b"), b: z.string() }),
      ]),
    });
const moving = () =>
  ticket()
    .on({ Move })
    .loads(AgentLoad, (_, s) => `a-${s.agent}`, ["Dropped"], "current")
    .loads(AgentLoad, (d) => `a-${d.agent}`, ["Taken"], "next");

describe("what compiles", () => {
  it("types the handler's arguments", () => {
    moving().emit((data, { state }, { stream }, { current, next }) => {
      expectTypeOf(data).toEqualTypeOf<Readonly<{ agent: string }>>();
      expectTypeOf(state.agent).toEqualTypeOf<string | undefined>();
      expectTypeOf(stream).toEqualTypeOf<string>();
      expectTypeOf(current.open).toEqualTypeOf<number>();
      expectTypeOf(next.open).toEqualTypeOf<number>();
      return [["Moved", data]];
    });
  });

  it("takes every form of return, with no cast", () => {
    moving().emit((data) => ["Moved", data]);
    moving().emit((data) => [["Moved", data]]);
    moving().emit(() => undefined);
    moving().emit(() => []);
    // The action's own event needn't come first.
    moving().emit((data) => [
      ["Taken", { at: 1 }],
      ["Moved", data],
    ]);
    moving().emit((data) => [
      ["Moved", data],
      ["Taken", { at: 1, by: { id: "x" } }],
    ]);
    moving().emit((data, { state }) =>
      state.agent
        ? [
            ["Moved", data],
            ["Dropped", {}],
            ["Taken", { at: 1 }],
          ]
        : [
            ["Moved", data],
            ["Taken", { at: 1 }],
          ]
    );
    moving().emit((data, { state }) => {
      if (state.agent) return [["Moved", data]];
      return undefined;
    });
    moving().emit(() => [
      ["Tagged", { tags: [{ t: "x" }] }],
      ["Contacted", { kind: "a", a: "x" }],
    ]);
    moving().emit(() => ["Open", { meta: { any: "thing" }, any: { x: 1 } }]);
    moving().emit(() => ["Dated", { at: new Date(), pair: [1, "x"] }]);
    moving().emit(() => {
      throw new Error("refused");
    });
    ticket().on({ Move }).emit("Moved");
    moving().emit("Moved");
  });

  it("keeps the types of a function with no parameters", () => {
    ticket()
      .on({ Clear: ZodEmpty })
      .emit(() => ["Moved", { agent: "x" }]);
  });
});

describe("a mistake is marked on the entry", () => {
  it("a misspelled event", () => {
    moving().emit((data) => [
      // @ts-expect-error did you mean "Moved"?
      ["Movedd", data],
    ]);
  });

  it("a misspelled event listed on a load", () => {
    moving().emit((data) => [
      ["Moved", data],
      // @ts-expect-error did you mean "Taken"?
      ["Takenn", { at: 1 }],
    ]);
  });

  it("an event no load lists", () => {
    moving().emit((data) => [
      ["Moved", data],
      // @ts-expect-error not an event of this state or its loads
      ["Unlisted", {}],
    ]);
  });

  it("a wrong field type", () => {
    moving().emit((data) => [
      ["Moved", data],
      // @ts-expect-error `at` is a number
      ["Taken", { at: "x" }],
    ]);
  });

  it("a missing field", () => {
    moving().emit((data) => [
      ["Moved", data],
      // @ts-expect-error `at` is required
      ["Taken", {}],
    ]);
  });

  it("an extra field", () => {
    moving().emit((data) => [
      ["Moved", data],
      // @ts-expect-error `extra` isn't in the schema
      ["Taken", { at: 1, extra: 2 }],
    ]);
  });

  it("an extra field in a nested object", () => {
    moving().emit((data) => [
      ["Moved", data],
      // @ts-expect-error `extra` isn't in the schema
      ["Taken", { at: 1, by: { id: "x", extra: 2 } }],
    ]);
  });

  it("an extra field in an array", () => {
    moving().emit((data) => [
      ["Moved", data],
      // @ts-expect-error `extra` isn't in the schema
      ["Tagged", { tags: [{ t: "x", extra: 1 }] }],
    ]);
  });

  it("a wrong type inside a tuple", () => {
    moving().emit((data) => [
      ["Moved", data],
      // @ts-expect-error the pair is a number and a string
      ["Dated", { at: new Date(), pair: [1, 2] }],
    ]);
  });

  it("data on an event that takes none", () => {
    moving().emit((data) => [
      ["Moved", data],
      // @ts-expect-error `Dropped` has no fields
      ["Dropped", { x: 1 }],
    ]);
  });
});

describe("a mistake a list can't place on one entry", () => {
  it("nothing for the action's own stream", () => {
    // @ts-expect-error an action must append an event to its own stream
    moving().emit(() => [["Taken", { at: 1 }]]);
    // @ts-expect-error an action must append an event to its own stream
    moving().emit(() => ["Taken", { at: 1 }]);
  });

  it("a state loading its own type, emitting only the listed event", () => {
    const Account = state({ Account: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Moved: Move, Noted: ZodEmpty })
      .build();
    const self = () =>
      state({ Account: z.object({ n: z.number() }) })
        .init(() => ({ n: 0 }))
        .emits({ Moved: Move, Noted: ZodEmpty })
        .on({ Go: Move })
        .loads(Account, (d) => d.agent, ["Moved"]);
    // @ts-expect-error the load gets `Moved`, so nothing goes to its own stream
    self().emit((d) => [["Moved", d]]);
    // @ts-expect-error the load gets `Moved`, so nothing goes to its own stream
    self().emit((d) => ["Moved", d]);
    self().emit((d) => [
      ["Noted", {}],
      ["Moved", d],
    ]);
  });

  it("a mistake in one branch marks the whole ternary", () => {
    moving().emit((data, { state }) =>
      // @ts-expect-error `at` is a number
      state.agent
        ? [
            ["Moved", data],
            ["Taken", { at: "x" }],
          ]
        : [["Moved", data]]
    );
    moving().emit((data, { state }) =>
      // @ts-expect-error one branch has nothing for its own stream
      state.agent ? [["Dropped", {}]] : [["Moved", data]]
    );
  });

  it("a mistake in a function with a body marks the function", () => {
    // @ts-expect-error `at` is a number
    moving().emit((data, { state }) => {
      if (state.agent)
        return [
          ["Moved", data],
          ["Taken", { at: "x" }],
        ];
      return [["Moved", data]];
    });
  });
});

describe("what a handler returns", () => {
  it("refuses anything that isn't events", () => {
    // @ts-expect-error not an event
    moving().emit(() => 42);
    // @ts-expect-error not an event
    moving().emit(() => null);
    // @ts-expect-error handlers aren't async
    moving().emit(async (d) => ["Moved", d]);
    // @ts-expect-error a tuple is a name and its data
    moving().emit(() => ["Moved"]);
    // @ts-expect-error a tuple is a name and its data
    moving().emit((d) => ["Moved", d, 1]);
  });

  it("refuses a function that forgets to return", () => {
    // @ts-expect-error return the events, or `undefined` to commit nothing
    moving().emit(() => {
      void 0;
    });
  });

  it("takes a function that returns on only some paths", () => {
    moving().emit((d) => {
      if (d.agent) return [["Moved", d]];
    });
  });
});

describe("the name form", () => {
  it("takes only the action's own events no load lists", () => {
    // @ts-expect-error a load lists it, so it would go to the loaded stream
    moving().emit("Taken");
    // @ts-expect-error not an event of this state
    ticket().on({ Move }).emit("Nope");
  });
});

describe(".loads", () => {
  const moving_once = () => ticket().on({ Move });

  it("marks a second load with the same name on the call", () => {
    expect(() =>
      moving_once()
        .loads(AgentLoad, (d) => d.agent)
        // @ts-expect-error name each load of the same state
        .loads(AgentLoad, (d) => d.agent)
    ).toThrow("twice");
  });

  it("offers only the loaded state's events", () => {
    expect(() =>
      // @ts-expect-error `AgentLoad` doesn't emit it
      moving_once().loads(AgentLoad, (d) => d.agent, ["Nope"])
    ).toThrow("doesn't emit it");
  });

  it("types its target and marks what it can't read", () => {
    // @ts-expect-error `Move` has no `nope`
    moving_once().loads(AgentLoad, (d) => d.nope);
    // @ts-expect-error a target returns a stream name
    moving_once().loads(AgentLoad, () => 42);
  });

  it("types the loaded state in a rule", () => {
    moving().requires([
      {
        description: "x",
        // @ts-expect-error there's no load named `nope`
        holds: (_, __, ___, { nope }) => !!nope,
      },
    ]);
    moving().requires([
      {
        description: "x",
        // @ts-expect-error `open` is a number
        holds: (_, __, ___, { next }) => next.open === "x",
      },
    ]);
  });
});
