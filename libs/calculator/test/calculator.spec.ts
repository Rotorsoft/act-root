import {
  act,
  app,
  dispose,
  Event,
  InvariantError,
  load,
  query,
  RegistrationError,
  store,
  ValidationError
} from "@rotorsoft/act";
import { Calculator } from "../src";

describe("Calculator lifecycle", () => {
  const stream = "A";
  const expected = {
    state: { result: -5.62, left: "-5.62" },
    applyCount: 5,
    stateCount: 1
  };
  let correlation = "";
  let midpoint: Date = new Date();

  beforeAll(async () => {
    await store().seed();
    app().with(Calculator);
    app().build();
    await app().listen();
  });

  afterAll(async () => {
    await dispose()();
  });

  it("should compute results", async () => {
    const actor = { id: "A", name: "B" };
    await act({ stream, action: "PressKey", data: { key: "-" } });
    await act({ stream, action: "PressKey", data: { key: "1" } });
    await act({ stream, action: "PressKey", data: { key: "2" } });
    await act({ stream, action: "PressKey", data: { key: "+" } });
    await act({ stream, action: "PressKey", data: { key: "2" } });
    await act({ stream, action: "PressKey", data: { key: "." } });
    await act({ stream, action: "PressKey", data: { key: "3" } });
    await act({ stream, action: "PressKey", data: { key: "*" } });
    await act({ stream, action: "PressKey", data: { key: "4" } });

    await new Promise((resolve) => setTimeout(resolve, 100));
    midpoint = new Date();
    await new Promise((resolve) => setTimeout(resolve, 100));

    await act({ stream, action: "PressKey", data: { key: "-" } });
    await act({ stream, action: "PressKey", data: { key: "5" } });
    await act({ stream, action: "PressKey", data: { key: "." } });
    await act({ stream, action: "PressKey", data: { key: "6" } });
    await act({ stream, action: "PressKey", data: { key: "/" }, actor });
    await act({ stream, action: "PressKey", data: { key: "7" }, actor });
    await act({ stream, action: "PressKey", data: { key: "." }, actor });
    await act({ stream, action: "PressKey", data: { key: "9" }, actor });
    const result = await act({
      stream,
      action: "PressKey",
      data: { key: "=" }
    });
    expect(result).toMatchObject(expected);
    correlation = result!.event!.meta.correlation;
  });

  it("should load the state", async () => {
    const snapshot = await load(Calculator(), { stream });
    expect(snapshot).toMatchObject(expected);
  });

  it("should load the state with callback", async () => {
    let max = 0;
    await load(Calculator(), { stream }, (s) => {
      max = Math.max(max, s.stateCount);
    });
    expect(max).toBe(1);
  });

  it("should query by stream", async () => {
    const events = [] as Event[];
    const { first, last, count } = await query({ stream }, (e) =>
      events.push(e)
    );
    // console.table(events);
    expect(events.length).toBe(19);
    expect(count).toBe(19);
    expect(first).toMatchObject({
      name: "OperatorPressed",
      data: { operator: "-" },
      version: 0
    });
    expect(last).toMatchObject({
      name: "EqualsPressed",
      data: {},
      version: 18
    });
  });

  it("should query by event name", async () => {
    const { first, last, count } = await query({ names: ["DigitPressed"] });
    expect(count).toBe(9);
    expect(first).toMatchObject({
      name: "DigitPressed",
      data: { digit: "1" },
      version: 1
    });
    expect(last).toMatchObject({
      name: "DigitPressed",
      data: { digit: "9" },
      version: 17
    });
  });

  it("should query by actor", async () => {
    const { first, last, count } = await query({ actor: "A" });
    expect(count).toBe(4);
    expect(first).toMatchObject({
      name: "OperatorPressed",
      data: { operator: "/" },
      version: 14
    });
    expect(last).toMatchObject({
      name: "DigitPressed",
      data: { digit: "9" },
      version: 17
    });
  });

  it("should query by correlation", async () => {
    const { first, last, count } = await query({ correlation });
    expect(count).toBe(1);
    expect(first).toMatchObject({
      name: "EqualsPressed",
      data: {},
      version: 18
    });
    expect(last).toMatchObject({
      name: "EqualsPressed",
      data: {},
      version: 18
    });
  });

  it("should query by created before", async () => {
    const { last, count } = await query({
      created_before: midpoint
    });
    expect(count).toBe(9);
    expect(last).toMatchObject({
      name: "DigitPressed",
      data: { digit: "4" },
      version: 8
    });
  });

  it("should query by created after", async () => {
    const { first, count } = await query({
      created_after: midpoint
    });
    expect(count).toBe(10);
    expect(first).toMatchObject({
      name: "OperatorPressed",
      data: { operator: "-" },
      version: 9
    });
  });

  it("should query before with limit", async () => {
    const { first, last, count } = await query({
      before: 6,
      limit: 3
    });
    expect(count).toBe(3);
    expect(first).toMatchObject({
      name: "OperatorPressed",
      data: { operator: "-" },
      version: 0
    });
    expect(last).toMatchObject({
      name: "DigitPressed",
      data: { digit: "2" },
      version: 2
    });
  });

  it("should query after with limit", async () => {
    const { first, last, count } = await query({
      after: 6,
      limit: 2
    });
    expect(count).toBe(2);
    expect(first).toMatchObject({
      name: "OperatorPressed",
      data: { operator: "*" },
      version: 7
    });
    expect(last).toMatchObject({
      name: "DigitPressed",
      data: { digit: "4" },
      version: 8
    });
  });

  it("should query by stream and actor after acting on a second stream", async () => {
    await act(
      { stream: "B", action: "PressKey", data: { key: "1" } },
      undefined,
      true
    );
    await act(
      { stream: "B", action: "PressKey", data: { key: "1" } },
      undefined,
      true
    );
    await act(
      {
        stream: "B",
        action: "PressKey",
        data: { key: "1" },
        expectedVersion: 1
      },
      undefined,
      true
    );
    const { count } = await query({ stream, actor: "A" });
    expect(count).toBe(4);
  });

  it("should not return anything with actor and before", async () => {
    const { count } = await query({ actor: "A", before: 6 });
    expect(count).toBe(0);
  });

  it("should throw invariant error", async () => {
    await act({ stream, action: "Clear", data: {} });
    await expect(act({ stream, action: "Clear", data: {} })).rejects.toThrow(
      InvariantError
    );
  });

  it("should throw validation error", async () => {
    await expect(
      act({ stream, action: "PressKey", data: { key: 123 } })
    ).rejects.toThrow(ValidationError);
  });

  it("should throw when action not registered", async () => {
    await expect(
      act({ stream, action: "InvalidAction", data: { key: "5" } })
    ).rejects.toThrow(RegistrationError);
  });

  it("should throw no operator error", async () => {
    await expect(
      act({ stream: "C", action: "PressKey", data: { key: "=" } })
    ).rejects.toThrow("no operator");
  });

  it("should throw missing target stream error", async () => {
    await expect(
      // @ts-expect-error missing stream
      act({ action: "PressKey", data: { key: "=" } })
    ).rejects.toThrow("Missing target stream");
  });
});
