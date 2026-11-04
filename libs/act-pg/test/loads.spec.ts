import {
  act,
  type Committed,
  ConcurrencyError,
  PreconditionError,
  type Schemas,
  type Snapshot,
  type Store,
  state,
  ValidationError,
} from "@rotorsoft/act";
import { sandbox } from "@rotorsoft/act/test";
import { z } from "zod";
import { PostgresStore } from "../src/index.js";
import { schema } from "./schema.js";

/**
 * `.loads` through a whole action on Postgres: the core suite runs it on
 * the in-memory store, and the store's own suite runs `commit` alone. Here
 * the routing, the guard on each stream and the retries meet the real
 * transaction.
 */

const SeatTaken = z.object({ student: z.string() });
const Seats = state({
  Seats: z
    .object({ taken: z.number() })
    .refine((s) => s.taken <= 3, "the course is full"),
})
  .init(() => ({ taken: 0 }))
  .emits({ SeatTaken })
  .patch({ SeatTaken: (_, s) => ({ taken: s.taken + 1 }) })
  .on({ TakeSeat: SeatTaken })
  .emit("SeatTaken")
  .build();

const Enroll = z.object({ course: z.string(), student: z.string() });
const course = (data: { course: string }) => `course-${data.course}`;
const Enrollment = state({ Enrollment: Enroll })
  .init(() => ({ course: "", student: "" }))
  .emits({ Enrolled: Enroll })
  .on({ Enroll }, { maxRetries: 8 })
  .loads(Seats, course, ["SeatTaken"])
  .requires([
    {
      description: "the course has a free seat",
      holds: (_, __, ___, { Seats }) => Seats.taken < 3,
    },
  ])
  .emit((data) => [
    ["Enrolled", data],
    ["SeatTaken", { student: data.student }],
  ])
  // No precondition and no retries: the schema refuses, a race surfaces.
  .on({ Overfill: Enroll })
  .loads(Seats, course, ["SeatTaken"])
  .emit((data) => [
    ["Enrolled", data],
    ["SeatTaken", { student: data.student }],
  ])
  .build();

const actor = { id: "a", name: "a" };
const at = (stream: string) => ({ stream, actor });
const seat = (student: string) => ({ course: "c", student });

const events = async (db: Store, stream: string) => {
  const found: Committed<Schemas, keyof Schemas>[] = [];
  await db.query((e) => found.push(e), { stream, stream_exact: true });
  return found;
};

describe(".loads on Postgres", () => {
  let seq = 0;
  const disposers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  });

  const app_on_store = async () => {
    const box = await sandbox(act().withState(Seats).withState(Enrollment), {
      store: () =>
        new PostgresStore({
          port: 5431,
          schema: schema(`loads_${++seq}`),
          table: "events",
        }),
    });
    // The sandbox leaves a Postgres schema behind, rows and all.
    await box.store.drop();
    await box.store.seed();
    disposers.push(async () => {
      await box.store.drop();
      await box.dispose();
    });
    return box;
  };

  it("commits both streams at once and fires committed once per stream", async () => {
    const { app, store } = await app_on_store();
    const heard: Snapshot<Schemas, Schemas>[][] = [];
    app.on("committed", (snapshots) => {
      heard.push(snapshots);
    });
    const snapshots = await app.do("Enroll", at("enr-1"), seat("s1"));
    expect(snapshots.map((s) => s.event?.name)).toEqual(["Enrolled"]);
    const [own] = await events(store, "enr-1");
    const [other] = await events(store, "course-c");
    expect(own.name).toBe("Enrolled");
    expect(other.name).toBe("SeatTaken");
    // Own first, in one id range, with one correlation.
    expect(other.id).toBe(own.id + 1);
    expect(other.meta.correlation).toBe(own.meta.correlation);
    expect(heard.map((h) => h[0].event?.stream)).toEqual(["enr-1", "course-c"]);
    expect((await app.load(Seats, "course-c")).state.taken).toBe(1);
  });

  it("stores nothing on either stream when a rule or a schema refuses", async () => {
    const { app, store } = await app_on_store();
    for (const i of [1, 2, 3])
      await app.do("TakeSeat", at("course-c"), { student: `s${i}` });
    await expect(app.do("Enroll", at("enr-2"), seat("late"))).rejects.toThrow(
      PreconditionError
    );
    await expect(app.do("Overfill", at("enr-3"), seat("late"))).rejects.toThrow(
      ValidationError
    );
    expect(await events(store, "enr-2")).toEqual([]);
    expect(await events(store, "enr-3")).toEqual([]);
    expect(await events(store, "course-c")).toHaveLength(3);
  });

  it("a rival on the loaded stream refuses the whole commit, naming that stream", async () => {
    const { app, store } = await app_on_store();
    const commit = store.commit.bind(store);
    vi.spyOn(store, "commit").mockImplementationOnce(async (...args) => {
      await commit(
        [
          {
            stream: "course-c",
            msgs: [{ name: "SeatTaken", data: { student: "rival" } }],
          },
        ],
        { correlation: "rival", causation: {} }
      );
      return commit(...args);
    });
    const err = await app
      .do("Overfill", at("enr-4"), seat("s"))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConcurrencyError);
    expect((err as ConcurrencyError).stream).toBe("course-c");
    expect(await events(store, "enr-4")).toEqual([]);
    expect(await events(store, "course-c")).toHaveLength(1);
  });

  it("racing enrollments fill the seats exactly: the rest are refused by the rule", async () => {
    const { app, store } = await app_on_store();
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5, 6].map((i) =>
        app.do("Enroll", at(`race-${i}`), seat(`s${i}`))
      )
    );
    const refused = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const r of refused)
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(
        PreconditionError
      );
    expect(await events(store, "course-c")).toHaveLength(3);
    expect((await app.load(Seats, "course-c")).state.taken).toBe(3);
  });
});
