import { ActBuilder, Actor, dispose, sleep, store } from "@rotorsoft/act";
import { Calculator } from "../../src/calculator";

describe("calculator lifecycle", () => {
  const actor_a: Actor = { id: "A", name: "A" };
  const actor_x: Actor = { id: "X", name: "X" };
  const stream = "A";
  const expected = {
    state: { result: -5.62, left: "-5.62" },
    patches: 5,
    snaps: 1,
  };
  let correlation = "";
  let midpoint: Date = new Date();

  const act = new ActBuilder().with(Calculator).build();

  beforeAll(async () => {
    await store().seed();
  });

  afterAll(async () => {
    await dispose()();
  });

  it("should compute results", async () => {
    await act.do("PressKey", { stream, actor: actor_x }, { key: "-" });
    await act.do("PressKey", { stream, actor: actor_x }, { key: "1" });
    await act.do("PressKey", { stream, actor: actor_x }, { key: "2" });
    await act.do("PressKey", { stream, actor: actor_x }, { key: "+" });
    await act.do("PressKey", { stream, actor: actor_x }, { key: "2" });
    await act.do("PressKey", { stream, actor: actor_x }, { key: "." });
    await act.do("PressKey", { stream, actor: actor_x }, { key: "3" });
    await act.do("PressKey", { stream, actor: actor_x }, { key: "*" });
    await act.do("PressKey", { stream, actor: actor_x }, { key: "4" });

    await sleep(5);
    midpoint = new Date();
    await sleep(5);

    await act.do("PressKey", { stream, actor: actor_x }, { key: "-" });
    await act.do("PressKey", { stream, actor: actor_x }, { key: "5" });
    await act.do("PressKey", { stream, actor: actor_x }, { key: "." });
    await act.do("PressKey", { stream, actor: actor_x }, { key: "6" });
    await act.do("PressKey", { stream, actor: actor_a }, { key: "/" });
    await act.do("PressKey", { stream, actor: actor_a }, { key: "7" });
    await act.do("PressKey", { stream, actor: actor_a }, { key: "." });
    await act.do("PressKey", { stream, actor: actor_a }, { key: "9" });
    const result = await act.do(
      "PressKey",
      { stream, actor: actor_x },
      { key: "=" }
    );
    expect(result).toMatchObject(expected);
    correlation = result.event!.meta.correlation;
  });

  it("should load the state", async () => {
    const snapshot = await act.load(Calculator, stream);
    expect(snapshot).toMatchObject(expected);
  });

  it("should load the state with callback", async () => {
    let max = 0;
    await act.load(Calculator, stream, (snap) => {
      max = Math.max(max, snap.snaps);
    });
    expect(max).toBe(1);
  });

  it("should query by stream", async () => {
    const events = [];
    const { first, last, count } = await act.query({ stream }, (e) =>
      events.push(e)
    );
    // console.table(events);
    expect(events.length).toBe(19);
    expect(count).toBe(19);
    expect(first).toMatchObject({
      name: "OperatorPressed",
      data: { operator: "-" },
      version: 0,
    });
    expect(last).toMatchObject({
      name: "EqualsPressed",
      data: {},
      version: 18,
    });
  });

  it("should query by event name", async () => {
    const { first, last, count } = await act.query({ names: ["DigitPressed"] });
    expect(count).toBe(9);
    expect(first).toMatchObject({
      name: "DigitPressed",
      data: { digit: "1" },
      version: 1,
    });
    expect(last).toMatchObject({
      name: "DigitPressed",
      data: { digit: "9" },
      version: 17,
    });
  });

  it("should query by correlation", async () => {
    const { first, last, count } = await act.query({ correlation });
    expect(count).toBe(1);
    expect(first).toMatchObject({
      name: "EqualsPressed",
      data: {},
      version: 18,
    });
    expect(last).toMatchObject({
      name: "EqualsPressed",
      data: {},
      version: 18,
    });
  });

  it("should query by created before", async () => {
    const { last, count } = await act.query({
      created_before: midpoint,
    });
    expect(count).toBe(9);
    expect(last).toMatchObject({
      name: "DigitPressed",
      data: { digit: "4" },
      version: 8,
    });
  });

  it("should query by created after", async () => {
    const { first, count } = await act.query({
      created_after: midpoint,
    });
    expect(count).toBe(10);
    expect(first).toMatchObject({
      name: "OperatorPressed",
      data: { operator: "-" },
      version: 9,
    });
  });

  it("should query before with limit", async () => {
    const { first, last, count } = await act.query({
      before: 6,
      limit: 3,
    });
    expect(count).toBe(3);
    expect(first).toMatchObject({
      name: "OperatorPressed",
      data: { operator: "-" },
      version: 0,
    });
    expect(last).toMatchObject({
      name: "DigitPressed",
      data: { digit: "2" },
      version: 2,
    });
  });

  it("should query after with limit", async () => {
    const { first, last, count } = await act.query({
      after: 6,
      limit: 2,
    });
    expect(count).toBe(2);
    expect(first).toMatchObject({
      name: "OperatorPressed",
      data: { operator: "*" },
      version: 7,
    });
    expect(last).toMatchObject({
      name: "DigitPressed",
      data: { digit: "4" },
      version: 8,
    });
  });
});
