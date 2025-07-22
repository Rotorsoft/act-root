import { InMemoryStore } from "../src/adapters/InMemoryStore.js";
import { store } from "../src/index.js";
import { actor, app } from "./digit-board.js";

describe("digit-board", () => {
  beforeAll(() => {
    store(new InMemoryStore());
  });

  it("should count digits", async () => {
    await app.do("PressKey", { stream: "A", actor }, { key: "1" });
    await app.do("PressKey", { stream: "A", actor }, { key: "2" });
    await app.do("PressKey", { stream: "A", actor }, { key: "3" });

    // drain digit board stream
    const drained = await app.drain();
    expect(drained.acked.length).toBe(1);
  });
});
