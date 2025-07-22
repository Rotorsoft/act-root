import { InMemoryStore } from "../src/adapters/InMemoryStore.js";
import { Committed, Schemas, store } from "../src/index.js";
import { actor, app } from "./digit-board.js";

describe("digit-board", () => {
  beforeAll(() => {
    store(new InMemoryStore(0));
  });

  it("should count digits", async () => {
    await app.do("PressKey", { stream: "A", actor }, { key: "1" });
    await app.do("PressKey", { stream: "A", actor }, { key: "2" });
    await app.do("PressKey", { stream: "A", actor }, { key: "3" });

    const events: Committed<Schemas, keyof Schemas>[] = [];
    await app.query({ stream: "A" }, (e) => events.push(e));

    // make sure the events are correlated
    const leases = await app.correlate<Schemas>(events);
    expect(leases.length).toBe(1);
    expect(leases[0].stream).toBe("Board");
    expect(leases[0].payloads.length).toBe(3);

    // drain digit board stream
    const drained = await app.drain();
    expect(drained).toBe(1);
  });
});
