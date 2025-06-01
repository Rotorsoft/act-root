import { z } from "zod/v4";
import {
  ActBuilder,
  Actor,
  dispose,
  Infer,
  type Schema,
  type Schemas,
  type State,
  ZodEmpty,
} from "../src";

const events = {
  Event1: z.object({}),
  Event2: z.object({}),
};
const actions = {
  Act1: z.object({}),
  Act2: z.object({}),
};
const schemas = {
  events,
  actions,
  state: z.object({}),
};

function A1(): Infer<typeof schemas> {
  return {
    ...schemas,
    init: () => ({}),
    patch: { Event1: () => ({}), Event2: () => ({}) },
    on: {
      Act1: () => Promise.resolve(["Event1", {}]),
      Act2: () => Promise.resolve(["Event1", {}]),
    },
  };
}

function A2(): State<Schemas, Schemas, Schema> {
  return {
    events: { Event22: ZodEmpty },
    actions: {
      Act1: ZodEmpty,
    },
    state: ZodEmpty,
    init: () => ({}),
    patch: { Event22: () => ({}) },
    on: { Act1: () => Promise.resolve(["Event22", {}]) },
  };
}

function A3(): State<Schemas, Schemas, Schema> {
  return {
    events: { Event1: ZodEmpty, Event2: ZodEmpty },
    actions: {
      Act3: ZodEmpty,
    },
    state: ZodEmpty,
    init: () => ({}),
    patch: { Event1: () => ({}), Event2: () => ({}) },
    on: { Act3: () => Promise.resolve(["Event1", {}]) },
  };
}

describe("Builder", () => {
  const actor: Actor = { id: "1", name: "Actor" };

  afterEach(async () => {
    await dispose()();
  });

  it("should act ok, but no events emitted", async () => {
    const act = new ActBuilder()
      .with(A1)
      .on("Event1")
      .do(() => Promise.resolve())
      .void()
      .on("Event2")
      .do(() => Promise.resolve())
      .to("abc")
      .build();

    const result = await act.do("Act1", { stream: "A", actor }, {});
    expect(result).toBeDefined();
  });

  it("should throw duplicate action", () => {
    const builder = new ActBuilder().with(A1);
    expect(() => builder.with(A2)).toThrow('Duplicate action "Act1"');
  });

  it("should throw duplicate event", () => {
    const builder = new ActBuilder().with(A1);
    expect(() => builder.with(A3)).toThrow('Duplicate event "Event1"');
  });
});
