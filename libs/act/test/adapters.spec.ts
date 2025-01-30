import { app, ConcurrencyError, dispose, store, type Msg } from "../src";
import { InMemoryApp } from "../src/adapters/InMemoryApp";
import { InMemoryStore } from "../src/adapters/InMemoryStore";

describe("adapters", () => {
  beforeAll(async () => {
    store(InMemoryStore());
    await store().seed();
    app(new InMemoryApp());
    app().build();
    await app().listen();
  });

  afterAll(async () => {
    await store().drop();
    const count = await store().query(() => {});
    expect(count).toBe(0);
    await dispose()();
  });

  describe("InMemoryStore", () => {
    const stream = "B";
    const events = [
      { name: "A", data: { a: 1 } },
      { name: "B", data: { b: 2 } },
      { name: "C", data: { c: 3 } }
    ] as Msg[];
    const meta = {
      correlation: "1",
      causation: { action: { name: "A", stream } }
    };

    it("should throw concurrency error", async () => {
      const committed = await store().commit(stream, events, meta, 0);
      expect(committed.length).toBe(events.length);
      try {
        await store().commit(stream, events, meta, 1);
      } catch (error) {
        expect(error).toBeInstanceOf(ConcurrencyError);
      }
      const count = await store().query(() => {});
      expect(count).toBe(events.length);
    });
  });
});
