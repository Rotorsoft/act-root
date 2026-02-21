import { z } from "zod";
import { act, state, store } from "../src/index.js";

type MyActor = { id: string; name: string; role: string; tenantId: string };

describe("actor generic", () => {
  const Counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ Incremented: z.object({ by: z.number() }) })
    .patch({
      Incremented: ({ data }, s) => ({ count: s.count + data.by }),
    })
    .on({ increment: z.object({ by: z.number() }) })
    .emit("Incremented")
    .build();

  beforeEach(async () => {
    await store().seed();
  });

  it("should accept richer actor in app.do() via .withActor()", async () => {
    const app = act().withActor<MyActor>().withState(Counter).build();

    const target = {
      stream: "counter-1",
      actor: { id: "1", name: "Alice", role: "admin", tenantId: "t1" },
    };
    const snaps = await app.do("increment", target, { by: 5 });
    expect(snaps[0].state.count).toBe(5);
  });

  it("should preserve extra actor fields in event metadata via .loose()", async () => {
    const app = act().withActor<MyActor>().withState(Counter).build();

    const target = {
      stream: "counter-2",
      actor: { id: "2", name: "Bob", role: "user", tenantId: "t2" },
    };
    await app.do("increment", target, { by: 3 });

    const events = await app.query_array({ stream: "counter-2" });
    expect(events.length).toBe(1);
    const actor = events[0].meta.causation.action?.actor;
    expect(actor).toBeDefined();
    expect(actor!.id).toBe("2");
    expect(actor!.name).toBe("Bob");
    // Extra fields preserved thanks to .loose() on ActorSchema
    expect((actor as any).role).toBe("user");
    expect((actor as any).tenantId).toBe("t2");
  });

  it("should work with default actor (no .withActor())", async () => {
    const app = act().withState(Counter).build();

    const target = {
      stream: "counter-3",
      actor: { id: "1", name: "Default" },
    };
    const snaps = await app.do("increment", target, { by: 1 });
    expect(snaps[0].state.count).toBe(1);
  });

  it("should type-check .withActor() reactions with typed Dispatcher", async () => {
    const reactionTarget = {
      stream: "counter-4",
      actor: { id: "sys", name: "System", role: "system", tenantId: "t0" },
    };

    const app = act()
      .withActor<MyActor>()
      .withState(Counter)
      .on("Incremented")
      .do(async (_event, _stream, dispatcher) => {
        await dispatcher.do("increment", reactionTarget, { by: 1 });
      })
      .void()
      .build();

    const target = {
      stream: "counter-5",
      actor: { id: "1", name: "Alice", role: "admin", tenantId: "t1" },
    };
    await app.do("increment", target, { by: 10 });
    expect(true).toBe(true); // Compiles and runs
  });
});
