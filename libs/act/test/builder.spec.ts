import {
  ActBuilder,
  dispose,
  type Schema,
  type Schemas,
  type State,
  ZodEmpty,
} from "../src";

function A1(): State<Schemas, Schemas, Schema> {
  return {
    events: { Event1: ZodEmpty, Event2: ZodEmpty },
    actions: {
      Act1: ZodEmpty,
      Act2: ZodEmpty,
    },
    state: ZodEmpty,
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
  afterEach(async () => {
    await dispose()();
  });

  it("should act ok, but no events emitted", async () => {
    const act = new ActBuilder().with(A1).build();
    const result = await act.do("Act1", { stream: "A" }, {});
    expect(result).toBeDefined();
    expect(act.events["Event1"]).toBeDefined();
    expect(act.events["Event2"]).toBeDefined();
    expect(act.events["Event1"].schema).toMatchObject(ZodEmpty);
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
