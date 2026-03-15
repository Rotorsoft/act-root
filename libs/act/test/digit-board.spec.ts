import { InMemoryStore } from "../src/adapters/InMemoryStore.js";
import { dispose, store } from "../src/index.js";
import { actor, app } from "./digit-board.js";

describe("digit-board", () => {
  beforeAll(() => {
    store(new InMemoryStore());
  });

  afterAll(async () => {
    await dispose()();
  });

  it("should count digits", async () => {
    await app.do("PressKey", { stream: "A", actor }, { key: "1" });
    await app.do("PressKey", { stream: "A", actor }, { key: "2" });
    await app.do("PressKey", { stream: "A", actor }, { key: "3" });

    const { subscribed } = await app.correlate();
    // "Board" static target is subscribed at init, not during correlate
    // Dynamic target "CalculatorA" is not yet triggered (no OperatorPressed)
    expect(subscribed).toBe(0);

    // drain digit board stream
    const drained = await app.drain();
    expect(drained.acked.length).toBe(1);
  });
});
