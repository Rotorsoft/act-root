import { describe, expect, expectTypeOf, vi } from "vitest";
import { z } from "zod";
import {
  act,
  type Committed,
  ConcurrencyError,
  InMemoryStore,
  type Precondition,
  PreconditionError,
  type Schemas,
  type Snapshot,
  type Store,
  StreamClosedError,
  sensitive,
  state,
  store,
  ValidationError,
} from "../src/index.js";
import { fixture } from "../src/test/index.js";

/**
 * `.loads(...)`: an action loads the other streams its decision needs,
 * emits the events listed on each load to that load's stream, and commits
 * every stream it writes in one step, each guarded by its version at load.
 */

const SeatTaken = z.object({ student: z.string() });
const Seats = state({
  Seats: z
    .object({ taken: z.number(), capacity: z.number() })
    .refine((s) => s.taken <= s.capacity, "the course is full"),
})
  .init(() => ({ taken: 0, capacity: 2 }))
  .emits({ SeatTaken })
  .patch({ SeatTaken: (_, s) => ({ taken: s.taken + 1 }) })
  // The owner emits the same event from its own action.
  .on({ TakeSeat: SeatTaken })
  .emit("SeatTaken")
  .build();

const Enroll = z.object({ course: z.string(), student: z.string() });
const course = (data: { course: string }) => `course-${data.course}`;
const free_seat = {
  description: "the course has a free seat",
  holds: (
    _: unknown,
    __: unknown,
    ___: unknown,
    { Seats }: { Seats: { taken: number; capacity: number } }
  ) => Seats.taken < Seats.capacity,
};

const Enrollment = state({ Enrollment: Enroll })
  .init(() => ({ course: "", student: "" }))
  .emits({ Enrolled: Enroll })
  .on({ Enroll }, { maxRetries: 1 })
  .loads(Seats, course, ["SeatTaken"])
  .requires([free_seat])
  .emit((data) => [
    ["Enrolled", data],
    ["SeatTaken", { student: data.student }],
  ])
  // No precondition: the schema refuses.
  .on({ Overfill: Enroll })
  .loads(Seats, course, ["SeatTaken"])
  .emit((data) => [
    ["Enrolled", data],
    ["SeatTaken", { student: data.student }],
  ])
  // Nothing to its own stream: refused at the call.
  .on({ Grab: Enroll })
  .loads(Seats, course, ["SeatTaken"])
  // @ts-expect-error nothing to its own stream fails to compile
  .emit((data) => [["SeatTaken", { student: data.student }]])
  // A read: the stream isn't written, so it isn't guarded.
  .on({ Audit: Enroll })
  .loads(Seats, course)
  .requires([free_seat])
  .emit("Enrolled")
  .build();

const Amount = z.object({ amount: z.number() });
const Account = state({ Account: z.object({ balance: z.number().min(0) }) })
  .init(() => ({ balance: 0 }))
  .emits({ Deposited: Amount, Debited: Amount, Credited: Amount })
  .patch({
    Deposited: ({ data }, s) => ({ balance: s.balance + data.amount }),
    Debited: ({ data }, s) => ({ balance: s.balance - data.amount }),
    Credited: ({ data }, s) => ({ balance: s.balance + data.amount }),
  })
  .on({ Deposit: Amount })
  .emit("Deposited")
  .build();

const TransferData = z.object({
  from: z.string(),
  to: z.string(),
  amount: z.number(),
});
const Transfer = state({ Transfer: TransferData })
  .init(() => ({ from: "", to: "", amount: 0 }))
  .emits({ Transferred: TransferData })
  .on({ Transfer: TransferData }, { maxRetries: 2 })
  .loads(Account, (data) => data.from, ["Debited"], "from")
  .loads(Account, (data) => data.to, ["Credited"], "to")
  .requires([
    {
      description: "enough funds",
      holds: (data, _, __, { from }) => from.balance >= data.amount,
    },
  ])
  .emit((data, _, __, { from, to }) => {
    expectTypeOf(from.balance).toEqualTypeOf<number>();
    expectTypeOf(to.balance).toEqualTypeOf<number>();
    return [
      ["Transferred", data],
      ["Debited", { amount: data.amount }],
      ["Credited", { amount: data.amount }],
    ];
  })
  .build();

const reacted = vi.fn();
// The fixture's store, so a test can read and race it.
let db: Store;
const test = fixture(
  act()
    .withState(Seats)
    .withState(Enrollment)
    .withState(Account)
    .withState(Transfer)
    .on("SeatTaken")
    .do(async function log_seat(event) {
      reacted(event.stream);
    })
    .to(() => ({ target: "seat-log" })),
  { store: () => (db = new InMemoryStore()) }
);
const actor = { id: "a", name: "a" };
const at = (stream: string) => ({ stream, actor });
const rows = async (stream: string, from: Store = db) => {
  const found: Committed<Schemas, keyof Schemas>[] = [];
  await from.query((e) => found.push(e), { stream, stream_exact: true });
  return found;
};
const events = async (stream: string, from: Store = db) =>
  (await rows(stream, from)).map((e) => e.name);

describe("an action that loads another stream", () => {
  test("commits to both streams at once and returns its own snapshots", async ({
    app,
  }) => {
    const every = vi.fn();
    const seats = vi.fn();
    const enrollments = vi.fn();
    app.on("committed", every);
    app.on("committed", Seats, seats);
    app.on("committed", Enrollment, enrollments);

    const snapshots = await app.do("Enroll", at("enr-1"), {
      course: "c1",
      student: "s1",
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].event?.stream).toBe("enr-1");
    expectTypeOf(snapshots[0].state).toEqualTypeOf<z.infer<typeof Enroll>>();
    expect(await events("enr-1")).toEqual(["Enrolled"]);
    expect(await events("course-c1")).toEqual(["SeatTaken"]);
    // One commit: the two rows share the meta, and ids follow write order.
    const [enrolled] = await rows("enr-1");
    const [taken] = await rows("course-c1");
    expect(taken.id).toBe(enrolled.id + 1);
    expect(taken.meta).toEqual(enrolled.meta);
    expect(taken.meta.causation.action?.name).toBe("Enroll");

    // Once per stream appended to, its own first.
    expect(
      every.mock.calls.map(([snaps]: Snapshot<any, any>[][]) =>
        snaps.map((s) => s.event?.stream)
      )
    ).toEqual([["enr-1"], ["course-c1"]]);
    expect(seats.mock.calls[0][0][0].state).toEqual({ taken: 1, capacity: 2 });
    expect(enrollments.mock.calls[0][0]).toHaveLength(1);
    // The loaded stream's reactions wake.
    await vi.waitFor(() => expect(reacted).toHaveBeenCalledWith("course-c1"));
    // Its cache entry holds the folded state.
    const loaded = await app.load(Seats, "course-c1");
    expect(loaded.cache_hit).toBe(true);
    expect(loaded.state.taken).toBe(1);
  });

  test("refuses with PreconditionError over the loaded state, storing nothing", async ({
    app,
  }) => {
    await app.do("TakeSeat", at("course-c2"), { student: "x" });
    await app.do("TakeSeat", at("course-c2"), { student: "y" });
    await expect(
      app.do("Enroll", at("enr-2"), { course: "c2", student: "s" })
    ).rejects.toThrow(PreconditionError);
    expect(await events("enr-2")).toEqual([]);
    expect(await events("course-c2")).toEqual(["SeatTaken", "SeatTaken"]);
  });

  test("refuses a loaded state its schema rejects, storing nothing", async ({
    app,
  }) => {
    await app.do("TakeSeat", at("course-c3"), { student: "x" });
    await app.do("TakeSeat", at("course-c3"), { student: "y" });
    await expect(
      app.do("Overfill", at("enr-3"), { course: "c3", student: "s" })
    ).rejects.toThrow(ValidationError);
    expect(await events("course-c3")).toHaveLength(2);
  });

  test("an action that appends only to loaded streams throws, storing nothing", async ({
    app,
  }) => {
    await expect(
      app.do("Grab", at("enr-4"), { course: "c4", student: "s" })
    ).rejects.toThrow(
      'Action "Grab" appends only to the streams it loads; it must append an event to its own stream too'
    );
    expect(await events("course-c4")).toEqual([]);
    expect(await events("enr-4")).toEqual([]);
  });

  test("the owner's own action and an outside emitter both fold, told apart by causation", async ({
    app,
  }) => {
    await app.do("TakeSeat", at("course-c5"), { student: "x" });
    await app.do("Enroll", at("enr-5"), { course: "c5", student: "y" });
    const stored = await rows("course-c5");
    expect(stored.map((r) => r.meta.causation.action?.name)).toEqual([
      "TakeSeat",
      "Enroll",
    ]);
    expect((await app.load(Seats, "course-c5")).state.taken).toBe(2);
  });

  test("a target naming a new stream loads the initial state", async ({
    app,
  }) => {
    const target = vi.fn(course);
    const Probe = state({ Probe: z.object({ seen: z.number() }) })
      .init(() => ({ seen: -1 }))
      .emits({ Probed: z.object({ seen: z.number() }) })
      .on({ probe: Enroll })
      .loads(Seats, target)
      .emit((_, __, ___, { Seats }) => ["Probed", { seen: Seats.taken }])
      .build();
    const probe = await act().withState(Seats).withState(Probe).build();
    const [snap] = await probe.do("probe", at("probe-1"), {
      course: "new",
      student: "s",
    });
    expect(snap.state.seen).toBe(0);
    expect(target).toHaveBeenCalledWith(
      { course: "new", student: "s" },
      { seen: -1 }
    );
    expect(app).toBeDefined();
  });

  test("a load of a closed stream refuses the whole commit", async ({
    app,
  }) => {
    await app.do("TakeSeat", at("course-c6"), { student: "x" });
    // Close skips a stream whose reactions haven't run yet.
    await vi.waitFor(() => expect(reacted).toHaveBeenCalledWith("course-c6"));
    await vi.waitFor(async () =>
      expect((await app.close([{ stream: "course-c6" }])).truncated.size).toBe(
        1
      )
    );
    await expect(
      app.do("Enroll", at("enr-6"), { course: "c6", student: "s" })
    ).rejects.toThrow(StreamClosedError);
    expect(await events("enr-6")).toEqual([]);
  });

  test("time travel never runs loads", async ({ app }) => {
    await app.do("Enroll", at("enr-7"), { course: "c7", student: "s" });
    const past = await app.load(Enrollment, "enr-7", undefined, {
      before: 1e9,
    });
    expect(past.state.student).toBe("s");
  });
});

describe("a race on a loaded stream", () => {
  // Commits `rival` to its stream right before the next commit runs.
  const before_next_commit = (rival: () => Promise<unknown>) => {
    const commit = db.commit.bind(db);
    vi.spyOn(db, "commit").mockImplementationOnce(async (...args) => {
      await rival();
      return commit(...args);
    });
  };

  test("is retried with fresh loads, and the retry re-checks the rule", async ({
    app,
  }) => {
    await app.do("TakeSeat", at("course-r1"), { student: "x" });
    // The last seat goes to a rival between the load and the commit.
    before_next_commit(() =>
      app.do("TakeSeat", at("course-r1"), { student: "rival" })
    );
    await expect(
      app.do("Enroll", at("enr-r1"), { course: "r1", student: "s" })
    ).rejects.toThrow(PreconditionError);
    expect(await events("enr-r1")).toEqual([]);
    expect(await events("course-r1")).toEqual(["SeatTaken", "SeatTaken"]);
  });

  test("surfaces ConcurrencyError, naming the stream, past maxRetries", async ({
    app,
  }) => {
    await app.do("Deposit", at("acc-a"), { amount: 10 });
    const commit = db.commit.bind(db);
    vi.spyOn(db, "commit").mockImplementation(async (writes, meta) => {
      if (writes.length === 3)
        await commit(
          [
            {
              stream: "acc-b",
              msgs: [{ name: "Deposited", data: { amount: 1 } }],
            },
          ],
          meta
        );
      return commit(writes, meta);
    });
    const err = await app
      .do("Transfer", at("tr-1"), { from: "acc-a", to: "acc-b", amount: 5 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConcurrencyError);
    expect((err as ConcurrencyError).stream).toBe("acc-b");
    expect(await events("tr-1")).toEqual([]);
  });

  test("is retried even when the caller pins its own stream's version", async ({
    app,
  }) => {
    await app.do("Deposit", at("acc-c"), { amount: 10 });
    before_next_commit(() => app.do("Deposit", at("acc-d"), { amount: 1 }));
    await app.do(
      "Transfer",
      { ...at("tr-2"), expectedVersion: -1 },
      { from: "acc-c", to: "acc-d", amount: 5 }
    );
    expect((await app.load(Account, "acc-d")).state.balance).toBe(6);
  });

  test("on the pinned own stream is never retried", async ({ app }) => {
    await app.do("Deposit", at("acc-e"), { amount: 10 });
    before_next_commit(() =>
      db.commit(
        [
          {
            stream: "tr-3",
            msgs: [
              { name: "Transferred", data: { from: "x", to: "y", amount: 0 } },
            ],
          },
        ],
        { correlation: "", causation: {} }
      )
    );
    const err = await app
      .do(
        "Transfer",
        { ...at("tr-3"), expectedVersion: -1 },
        { from: "acc-e", to: "acc-f", amount: 5 }
      )
      .catch((e: unknown) => e);
    expect((err as ConcurrencyError).stream).toBe("tr-3");
  });

  test("on a read-only load lands anyway: reads aren't guarded", async ({
    app,
  }) => {
    before_next_commit(() =>
      app.do("TakeSeat", at("course-r2"), { student: "rival" })
    );
    await app.do("Audit", at("enr-r2"), { course: "r2", student: "s" });
    expect(await events("enr-r2")).toEqual(["Enrolled"]);
  });
});

describe("one state loaded twice, by name", () => {
  test("commits to three streams at once", async ({ app }) => {
    await app.do("Deposit", at("acc-1"), { amount: 10 });
    await app.do("Transfer", at("tr-10"), {
      from: "acc-1",
      to: "acc-2",
      amount: 4,
    });
    expect((await app.load(Account, "acc-1")).state.balance).toBe(6);
    expect((await app.load(Account, "acc-2")).state.balance).toBe(4);
    expect(await events("tr-10")).toEqual(["Transferred"]);
  });

  test("a state's committed listener hears each of its streams in its own call", async ({
    app,
  }) => {
    await app.do("Deposit", at("acc-5"), { amount: 10 });
    const heard: { stream?: string; balances: number[] }[] = [];
    app.on("committed", Account, (snapshots) =>
      heard.push({
        stream: snapshots[0].event?.stream,
        balances: snapshots.map((s) => s.state.balance),
      })
    );
    await app.do("Transfer", at("tr-12"), {
      from: "acc-5",
      to: "acc-6",
      amount: 4,
    });
    expect(heard).toEqual([
      { stream: "acc-5", balances: [6] },
      { stream: "acc-6", balances: [4] },
    ]);
  });

  test("refuses with the named load's precondition", async ({ app }) => {
    await expect(
      app.do("Transfer", at("tr-11"), { from: "acc-3", to: "acc-4", amount: 1 })
    ).rejects.toThrow("enough funds");
  });
});

describe("what an action may load and emit", () => {
  test("a load of its own stream refuses", async ({ app }) => {
    await expect(
      app.do("Enroll", at("course-c9"), { course: "c9", student: "s" })
    ).rejects.toThrow(
      'Enroll failed precondition: loads its own stream "course-c9"'
    );
  });

  test("two loads naming one stream refuse", async ({ app }) => {
    await expect(
      app.do("Transfer", at("tr-20"), { from: "acc-x", to: "acc-x", amount: 0 })
    ).rejects.toThrow(
      'Transfer failed precondition: loads stream "acc-x" twice'
    );
  });

  test("a target that names no stream refuses", async () => {
    const Blank = state({ Blank: z.object({}) })
      .init(() => ({}))
      .emits({ Done: z.object({}) })
      .on({ go: z.object({}) })
      .loads(Seats, () => "")
      .emit("Done")
      .build();
    const blank = act().withState(Seats).withState(Blank).build();
    await expect(blank.do("go", at("blank-1"), {})).rejects.toThrow(
      'go failed precondition: loads "Seats" from an empty stream name'
    );
  });

  test("a target that throws commits nothing", async () => {
    const Broken = state({ Broken: z.object({}) })
      .init(() => ({}))
      .emits({ Done: z.object({}) })
      .on({ go: z.object({}) })
      .loads(Seats, () => {
        throw new Error("no target");
      })
      .emit("Done")
      .build();
    const app = act().withState(Seats).withState(Broken).build();
    await expect(app.do("go", at("b-1"), {})).rejects.toThrow("no target");
    expect(await events("b-1", store())).toEqual([]);
  });

  test("an emitted event no load lists throws at the call", async () => {
    const Sneaky = state({ Sneaky: z.object({}) })
      .init(() => ({}))
      .emits({ Done: z.object({}) })
      .on({ go: z.object({}) })
      .loads(Seats, () => "course-s")
      // @ts-expect-error an event no load lists fails to compile
      .emit(() => ["SeatTaken", { student: "s" }])
      .build();
    const app = act().withState(Seats).withState(Sneaky).build();
    await expect(app.do("go", at("s-1"), {})).rejects.toThrow(
      'Action "go" emitted "SeatTaken", which isn\'t an event of "Sneaky" and isn\'t listed on any of its loads'
    );
  });

  test("a load of a state not registered in this Act throws at build", () => {
    expect(() => act().withState(Enrollment).build()).toThrow(
      'Action "Enroll" loads "Seats", which is not registered'
    );
  });

  const builder = () =>
    state({ X: z.object({}) })
      .init(() => ({}))
      .emits({ Done: z.object({}) })
      .on({ go: z.object({}) });

  test("a state loaded twice without names throws", () => {
    expect(() =>
      (builder().loads(Seats, () => "a") as any).loads(Seats, () => "b")
    ).toThrow('Action "go" loads "Seats" twice');
  });

  test("an event the loaded state doesn't emit throws", () => {
    expect(() => builder().loads(Seats, () => "a", ["Nope" as never])).toThrow(
      'Action "go" lists "Nope" on its load of "Seats", which doesn\'t emit it'
    );
  });

  test("an event listed on two loads throws", () => {
    expect(() =>
      builder()
        .loads(Seats, () => "a", ["SeatTaken"], "one")
        .loads(Seats, () => "b", ["SeatTaken" as never], "two")
    ).toThrow('Action "go" lists "SeatTaken" on two loads');
  });

  test("a static emit of an event its load lists fails to compile and throws at build", () => {
    const Move = z.object({ to: z.string() });
    const Moved = state({ Moved: z.object({}) })
      .init(() => ({}))
      .emits({ Moved: Move })
      .build();
    const Mover = state({ Moved: z.object({}) })
      .init(() => ({}))
      .emits({ Moved: Move })
      .on({ move: Move })
      .loads(Moved, (d) => d.to, ["Moved"])
      // @ts-expect-error the load gets it, so nothing goes to its own stream
      .emit("Moved")
      .build();
    expect(() => act().withState(Mover).build()).toThrow(
      'Action "move" statically emits "Moved", which its load lists, so nothing goes to its own stream; emit one of its own events too'
    );
  });

  test("a deprecated event listed on a load throws at build", () => {
    const Bumped = z.object({});
    const Counter = state({ Counter: z.object({}) })
      .init(() => ({}))
      .emits({ Bumped, Bumped_v2: Bumped })
      .patch({ Bumped: () => ({}), Bumped_v2: () => ({}) })
      .build();
    const bump = (events: ("Bumped" | "Bumped_v2")[]) =>
      act()
        .withState(Counter)
        .withState(
          state({ Bumper: z.object({}) })
            .init(() => ({}))
            .emits({ Done: z.object({}) })
            .on({ go: z.object({}) })
            .loads(Counter, () => "counter", events)
            .emit(() => [
              ["Done", {}],
              [events[0], {}],
            ])
            .build()
        )
        .build();
    expect(() => bump(["Bumped"])).toThrow(
      'Action "go" lists deprecated event "Bumped" on its load of "Counter". A newer version exists: "Bumped_v2".'
    );
    expect(() => bump(["Bumped_v2"])).not.toThrow();
  });
});

describe("partial states", () => {
  test("each Act loads its own merge of the loaded state", async () => {
    const SeatsExtra = state({ Seats: z.object({ extra: z.number() }) })
      .init(() => ({ extra: 5 }))
      .emits({ Extra: z.object({}) })
      .build();
    const seen: unknown[] = [];
    const Peek = state({ Peek: z.object({}) })
      .init(() => ({}))
      .emits({ Peeked: z.object({}) })
      .on({ peek: z.object({}) })
      .loads(Seats, () => "course-peek")
      .emit((_, __, ___, { Seats }) => {
        seen.push(Seats);
        return ["Peeked", {}];
      })
      .build();
    const first = act().withState(Seats).withState(Peek).build();
    // A second Act with another partial of Seats, built from the same states.
    act().withState(Seats).withState(SeatsExtra).withState(Peek).build();
    await first.do("peek", at("peek-1"), {});
    expect(seen).toEqual([{ taken: 0, capacity: 2 }]);
  });

  test("keep each action's loads when they merge", async () => {
    const Part = state({ Enrollment: z.object({ note: z.string() }) })
      .init(() => ({ note: "" }))
      .emits({ Noted: z.object({ note: z.string() }) })
      .on({ note: z.object({ note: z.string() }) })
      .emit("Noted")
      .build();
    const app = act()
      .withState(Seats)
      .withState(Part)
      .withState(Enrollment)
      .build();
    await app.do("Enroll", at("enr-p1"), { course: "p1", student: "s" });
    await app.do("note", at("enr-p1"), { note: "hi" });
    expect(await events("course-p1", store())).toEqual(["SeatTaken"]);
  });
});

describe("types", () => {
  const base = () =>
    state({ X: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Done: z.object({}) })
      .on({ go: z.object({ id: z.string() }) });

  test("a load name and its events are checked at compile time", () => {
    expect(() => {
      // @ts-expect-error an event the loaded state doesn't emit
      base().loads(Seats, () => "a", ["Nope"]);
    }).toThrow();
    expect(() => {
      base()
        .loads(Seats, () => "a")
        // @ts-expect-error a second unnamed load of the same state
        .loads(Seats, () => "b");
    }).toThrow();
    expect(() => {
      base()
        .loads(Seats, () => "a", ["SeatTaken"], "one")
        // @ts-expect-error an event already listed on another load
        .loads(Seats, () => "b", ["SeatTaken"], "two");
    }).toThrow();
    base()
      .loads(Seats, (payload, own) => {
        expectTypeOf(payload.id).toEqualTypeOf<string>();
        expectTypeOf(own.n).toEqualTypeOf<number>();
        return "a";
      })
      .requires([
        {
          description: "typed",
          // @ts-expect-error a load the action doesn't have
          holds: (_, __, ___, { Other }) => !!Other,
        },
      ]);
    // A shared rule that ignores the payload and the loads still fits.
    const positive: Precondition<{ n: number }, unknown> = {
      description: "n is positive",
      holds: (_, state) => state.n > 0,
    };
    base()
      .loads(Seats, () => "a")
      .requires([positive])
      .emit("Done");
    base()
      .loads(Seats, () => "a")
      // @ts-expect-error an event no load lists
      .emit(() => ["SeatTaken", { student: "s" }]);
    base()
      .loads(Seats, () => "a", ["SeatTaken"])
      // @ts-expect-error a listed event with the wrong payload
      .emit(() => ["SeatTaken", { student: 1 }]);
  });
});

describe("loads in a reaction, the cache, and sensitive fields", () => {
  test("a lost race drops the moved stream's cache entry", async ({ app }) => {
    await app.do("Deposit", at("acc-g"), { amount: 10 });
    await app.do("Deposit", at("acc-h"), { amount: 1 });
    expect((await app.load(Account, "acc-h")).cache_hit).toBe(true);
    const commit = db.commit.bind(db);
    vi.spyOn(db, "commit").mockImplementation(async (appends, meta) => {
      if (appends.length === 3)
        await commit(
          [
            {
              stream: "acc-h",
              msgs: [{ name: "Deposited", data: { amount: 1 } }],
            },
          ],
          meta
        );
      return commit(appends, meta);
    });
    await expect(
      app.do("Transfer", at("tr-g"), { from: "acc-g", to: "acc-h", amount: 5 })
    ).rejects.toThrow(ConcurrencyError);
    vi.restoreAllMocks();
    const reloaded = await app.load(Account, "acc-h");
    expect(reloaded.cache_hit).toBe(false);
    expect(reloaded.state.balance).toBe(4);
  });

  test("a reaction's action carries correlation and causation onto every stream", async () => {
    const Trigger = state({ Trigger: z.object({}) })
      .init(() => ({}))
      .emits({ Triggered: Enroll })
      .on({ trigger: Enroll })
      .emit("Triggered")
      .build();
    const app = act()
      .withState(Seats)
      .withState(Enrollment)
      .withState(Trigger)
      .on("Triggered")
      .do(async function enroll_on_trigger(event, _stream, app) {
        await app.do("Enroll", at(`enr-${event.data.student}`), event.data);
      })
      .to(() => ({ target: "enroller" }))
      .build();
    const [triggered] = await app.do("trigger", at("t-1"), {
      course: "rx",
      student: "s9",
    });
    await vi.waitFor(async () =>
      expect(await events("course-rx", store())).toEqual(["SeatTaken"])
    );
    for (const stream of ["enr-s9", "course-rx"]) {
      const [row] = await rows(stream, store());
      expect(row.meta.correlation).toBe(triggered.event!.meta.correlation);
      expect(row.meta.causation.event?.id).toBe(triggered.event!.id);
    }
  });

  test("a loaded stream loads with the caller's actor, so its sensitive fields are gated", async () => {
    const seen = vi.fn();
    const Vault = state({ Vault: z.object({ owner: z.string().email() }) })
      .init(() => ({ owner: "nobody@x.io" }))
      .emits({
        Claimed: z.object({ owner: sensitive(z.string()) }),
        Touched: z.object({}),
      })
      .patch({ Claimed: ({ data }) => ({ owner: data.owner }) })
      .discloses((_, actor) => actor.id === "owner")
      .on({ Claim: z.object({ owner: z.string() }) })
      .emit("Claimed")
      .build();
    const Visit = state({ Visit: z.object({}) })
      .init(() => ({}))
      .emits({ Visited: z.object({}) })
      .on({ visit: z.object({}) })
      .loads(Vault, () => "vault-1", ["Touched"])
      .emit((_, __, ___, { Vault }) => {
        seen(Vault.owner);
        return [
          ["Visited", {}],
          ["Touched", {}],
        ];
      })
      .build();
    const app = act().withState(Vault).withState(Visit).build();
    await app.do("Claim", at("vault-1"), { owner: "ann@x.io" });
    // A stranger sees the marker, and the vault's schema doesn't refuse it.
    await app.do("visit", at("visit-1"), {});
    await app.do(
      "visit",
      { stream: "visit-2", actor: { id: "owner", name: "o" } },
      {}
    );
    expect(seen.mock.calls.map(([owner]) => owner)).toEqual([
      "[REDACTED]",
      "ann@x.io",
    ]);
    expect(await events("vault-1", store())).toEqual([
      "Claimed",
      "Touched",
      "Touched",
    ]);
  });
});
