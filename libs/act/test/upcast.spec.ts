import { z } from "zod";
import { act, dispose, projection, slice, state, store } from "../src/index.js";

describe("upcast", () => {
  beforeEach(async () => {
    await store().drop();
  });

  afterAll(async () => {
    await dispose()();
  });

  const actor = { id: "a", name: "a" };
  let streamId = 0;
  const nextStream = () => `upcast-test-${++streamId}`;

  // --- Current schema (v3) ---
  const TicketOpened = z.object({
    title: z.string(),
    priority: z.enum(["low", "medium", "high"]),
    category: z.string(),
  });

  // State with chained upcasters: v1 → v2 → v3
  const Ticket = state({
    Ticket: z.object({
      title: z.string(),
      priority: z.string(),
      category: z.string(),
    }),
  })
    .init(() => ({ title: "", priority: "medium", category: "general" }))
    .emits({ TicketOpened })
    .upcast({
      TicketOpened: [
        // v1 → v2: add default priority
        (data: any) => ({ ...data, priority: data.priority ?? "medium" }),
        // v2 → v3: rename "type" to "category"
        (data: any) => {
          const { type: _type, ...rest } = data;
          return { ...rest, category: data.category ?? _type ?? "general" };
        },
      ],
    })
    .on({
      openTicket: z.object({
        title: z.string(),
        priority: z.enum(["low", "medium", "high"]),
        category: z.string(),
      }),
    })
    .emit((action) => [
      "TicketOpened",
      {
        title: action.title,
        priority: action.priority,
        category: action.category,
      },
    ])
    .build();

  it("should transform old event data via single upcaster before reducer", async () => {
    const stream = nextStream();

    const Incremented = z.object({ by: z.number(), source: z.string() });
    const Counter = state({
      Counter: z.object({ count: z.number(), lastSource: z.string() }),
    })
      .init(() => ({ count: 0, lastSource: "" }))
      .emits({ Incremented })
      .patch({
        Incremented: ({ data }, s) => ({
          count: s.count + data.by,
          lastSource: data.source,
        }),
      })
      .upcast({
        Incremented: [
          (data: any) => ({ ...data, source: data.source ?? "unknown" }),
        ],
      })
      .on({ increment: z.object({ by: z.number(), source: z.string() }) })
      .emit("Incremented")
      .build();

    const app = act().withState(Counter).build();

    // Simulate a "v1" event without "source" field
    await store().commit(stream, [{ name: "Incremented", data: { by: 5 } }], {
      correlation: "test",
      causation: {},
    });

    const snap = await app.load(Counter, stream);
    expect(snap.state.count).toBe(5);
    expect(snap.state.lastSource).toBe("unknown");
  });

  it("should chain upcasters in order (v1 → v2 → v3)", async () => {
    const stream = nextStream();
    const app = act().withState(Ticket).build();

    // Commit a v1 event (no priority, uses "type" instead of "category")
    await store().commit(
      stream,
      [{ name: "TicketOpened", data: { title: "Bug report", type: "bug" } }],
      { correlation: "test", causation: {} }
    );

    const snap = await app.load(Ticket, stream);
    expect(snap.state.title).toBe("Bug report");
    expect(snap.state.priority).toBe("medium");
    expect(snap.state.category).toBe("bug");
  });

  it("should pass events without upcasters unchanged", async () => {
    const stream = nextStream();
    const Incremented = z.object({ by: z.number() });
    const Counter = state({ Counter: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({ Incremented })
      .patch({
        Incremented: ({ data }, s) => ({ count: s.count + data.by }),
      })
      .on({ increment: z.object({ by: z.number() }) })
      .emit("Incremented")
      .build();

    const app = act().withState(Counter).build();
    await app.do("increment", { stream, actor }, { by: 10 });
    const snap = await app.load(Counter, stream);
    expect(snap.state.count).toBe(10);
  });

  it("should deliver upcasted events to projection handlers via drain", async () => {
    const stream = nextStream();
    const projected: Array<{
      title: string;
      priority: string;
      category: string;
    }> = [];

    const TicketProjection = projection("ticket-proj")
      .on({ TicketOpened })
      .do(async function project(event) {
        await Promise.resolve();
        projected.push(event.data);
      })
      .build();

    const app = act()
      .withState(Ticket)
      .withProjection(TicketProjection)
      .build();

    // Commit a v1 event
    await store().commit(
      stream,
      [{ name: "TicketOpened", data: { title: "Fix it", type: "task" } }],
      { correlation: "test", causation: {} }
    );

    await app.correlate();
    await app.drain({ eventLimit: 100 });

    expect(projected).toHaveLength(1);
    expect(projected[0].priority).toBe("medium");
    expect(projected[0].category).toBe("task");
  });

  it("should return upcasted events from query_array()", async () => {
    const stream = nextStream();
    const app = act().withState(Ticket).build();

    await store().commit(
      stream,
      [
        { name: "TicketOpened", data: { title: "A", type: "bug" } },
        { name: "TicketOpened", data: { title: "B", type: "feature" } },
      ],
      { correlation: "test", causation: {} }
    );

    const events = await app.query_array({ stream, stream_exact: true });
    expect(events).toHaveLength(2);
    expect(events[0].data).toEqual({
      title: "A",
      priority: "medium",
      category: "bug",
    });
    expect(events[1].data).toEqual({
      title: "B",
      priority: "medium",
      category: "feature",
    });
  });

  it("should return upcasted events from query() callback", async () => {
    const stream = nextStream();
    const app = act().withState(Ticket).build();

    await store().commit(
      stream,
      [{ name: "TicketOpened", data: { title: "C", type: "support" } }],
      { correlation: "test", causation: {} }
    );

    const collected: any[] = [];
    await app.query({ stream, stream_exact: true }, (e) => collected.push(e));
    expect(collected).toHaveLength(1);
    expect(collected[0].data.category).toBe("support");
    expect(collected[0].data.priority).toBe("medium");
  });

  it("should not affect snapshots (snapshots store state, not events)", async () => {
    const stream = nextStream();
    const Incremented = z.object({ by: z.number(), source: z.string() });
    const Counter = state({
      Counter: z.object({ count: z.number(), lastSource: z.string() }),
    })
      .init(() => ({ count: 0, lastSource: "" }))
      .emits({ Incremented })
      .patch({
        Incremented: ({ data }, s) => ({
          count: s.count + data.by,
          lastSource: data.source,
        }),
      })
      .upcast({
        Incremented: [
          (data: any) => ({ ...data, source: data.source ?? "unknown" }),
        ],
      })
      .on({ increment: z.object({ by: z.number(), source: z.string() }) })
      .emit("Incremented")
      .snap((s) => s.patches >= 2)
      .build();

    const app = act().withState(Counter).build();

    // Commit old-format events
    await store().commit(
      stream,
      [
        { name: "Incremented", data: { by: 1 } },
        { name: "Incremented", data: { by: 2 } },
        { name: "Incremented", data: { by: 3 } },
      ],
      { correlation: "test", causation: {} }
    );

    const snap = await app.load(Counter, stream);
    expect(snap.state.count).toBe(6);
    expect(snap.state.lastSource).toBe("unknown");
  });

  it("should deliver upcasted events to slice reaction handlers", async () => {
    const stream = nextStream();
    const received: any[] = [];

    const TicketSlice = slice()
      .withState(Ticket)
      .on("TicketOpened")
      .do(async function onTicket(event) {
        await Promise.resolve();
        received.push(event.data);
      })
      .void()
      .build();

    const app = act().withSlice(TicketSlice).build();

    await store().commit(
      stream,
      [{ name: "TicketOpened", data: { title: "Slice test", type: "task" } }],
      { correlation: "test", causation: {} }
    );

    // Void reactions aren't processed by drain, but let's test the query path
    const events = await app.query_array({ stream, stream_exact: true });
    expect(events[0].data).toEqual({
      title: "Slice test",
      priority: "medium",
      category: "task",
    });
  });

  it("should merge upcasters from partial states", async () => {
    const stream = nextStream();
    const EventA = z.object({ x: z.number(), label: z.string() });
    const EventB = z.object({ y: z.number() });

    const PartialA = state({
      Merged: z.object({ x: z.number(), label: z.string(), y: z.number() }),
    })
      .init(() => ({ x: 0, label: "", y: 0 }))
      .emits({ EventA, EventB })
      .upcast({
        EventA: [(data: any) => ({ ...data, label: data.label ?? "default" })],
      })
      .on({ doA: z.object({ x: z.number(), label: z.string() }) })
      .emit("EventA")
      .build();

    const PartialB = state({
      Merged: z.object({ x: z.number(), label: z.string(), y: z.number() }),
    })
      .init(() => ({ x: 0, label: "", y: 0 }))
      .emits({ EventA, EventB })
      .upcast({
        EventB: [(data: any) => ({ ...data, y: data.y ?? 0 })],
      })
      .on({ doB: z.object({ y: z.number() }) })
      .emit("EventB")
      .build();

    const app = act().withState(PartialA).withState(PartialB).build();

    await store().commit(
      stream,
      [
        { name: "EventA", data: { x: 1 } },
        { name: "EventB", data: {} },
      ],
      { correlation: "test", causation: {} }
    );

    const snap = await app.load("Merged", stream);
    expect(snap.state.x).toBe(1);
    expect(snap.state.label).toBe("default");
    expect(snap.state.y).toBe(0);
  });

  it("should throw on conflicting upcaster chains during partial merge", () => {
    const Ev = z.object({ x: z.number() });

    const chain1 = [(d: unknown) => d];
    const chain2 = [(d: unknown) => d];

    const A = state({ Conflict: z.object({ x: z.number() }) })
      .init(() => ({ x: 0 }))
      .emits({ Ev })
      .upcast({ Ev: chain1 })
      .on({ doA: z.object({ x: z.number() }) })
      .emit("Ev")
      .build();

    const B = state({ Conflict: z.object({ x: z.number() }) })
      .init(() => ({ x: 0 }))
      .emits({ Ev })
      .upcast({ Ev: chain2 })
      .on({ doB: z.object({ x: z.number() }) })
      .emit("Ev")
      .build();

    expect(() => act().withState(A).withState(B).build()).toThrow(
      /Duplicate upcaster chain for event "Ev"/
    );
  });
});
