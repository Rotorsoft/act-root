import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { act, Actor, dispose, state, ZodEmpty } from "../src/index.js";

const A1 = state("A1", z.object({}))
  .init(() => ({}))
  .emits({ Event1: z.object({}), Event2: z.object({}) })
  .patch({ Event1: () => ({}), Event2: () => ({}) })
  .on("Act1", z.object({}))
  .emit(() => ["Event1", {}])
  .on("Act2", z.object({}))
  .emit(() => ["Event2", {}])
  .build();

const A2 = state("A2", ZodEmpty)
  .init(() => ({}))
  .emits({ Event22: ZodEmpty })
  .patch({ Event22: () => ({}) })
  .on("Act1", ZodEmpty)
  .emit(() => ["Event22", {}])
  .build();

const A3 = state("A3", ZodEmpty)
  .init(() => ({}))
  .emits({ Event1: ZodEmpty, Event2: ZodEmpty })
  .patch({ Event1: () => ({}), Event2: () => ({}) })
  .on("Act3", ZodEmpty)
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
});
