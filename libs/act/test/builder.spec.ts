import { act, app, dispose, Empty, Rec, State, ZodEmpty } from "../src";

type Actions = {
  Act1: Empty;
  Act2: Empty;
};

type Events = {
  Event1: Empty;
  Event2: Empty;
};

function A1(): State<Rec, Actions, Events> {
  return {
    description: "A1",
    __state: ZodEmpty,
    __actions: {
      Act1: ZodEmpty,
      Act2: ZodEmpty
    },
    __events: {
      Event1: ZodEmpty,
      Event2: ZodEmpty
    },
    init: () => ({}),
    reduce: {
      Event1: () => ({}),
      Event2: () => ({})
    },
    on: {
      Act1: () => Promise.resolve([]),
      Act2: () => Promise.resolve([])
    }
  };
}

function A2(): State<Rec, Actions, Events> {
  return {
    ...A1()
  };
}

function A3(): State<Rec, { Act3: Empty }, Events> {
  return {
    description: "A3",
    __state: ZodEmpty,
    __actions: {
      Act3: ZodEmpty
    },
    __events: {
      Event1: ZodEmpty,
      Event2: ZodEmpty
    },
    init: () => ({}),
    reduce: {
      Event1: () => ({}),
      Event2: () => ({})
    },
    on: {
      Act3: () => Promise.resolve([])
    }
  };
}

describe("Builder", () => {
  afterEach(async () => {
    await dispose()();
  });

  it("should act ok, but no events emitted", async () => {
    app().with(A1);
    const result = await act({ stream: "A", action: "Act1", data: {} });
    expect(result).toBeUndefined();
  });

  it("should throw duplicate", () => {
    app().with(A1);
    expect(() => app().with(A1)).toThrow('Duplicate factory "A1"');
  });

  it("should throw duplicate action", () => {
    app().with(A1);
    expect(() => app().with(A2)).toThrow(
      'Duplicate action "Act1" found in "A1" and "A2"'
    );
  });

  it("should throw duplicate event", () => {
    app().with(A1);
    expect(() => app().with(A3)).toThrow(
      'Duplicate event "Event1" found in "A1" and "A3"'
    );
  });
});
