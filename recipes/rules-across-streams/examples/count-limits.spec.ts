import { PreconditionError, ValidationError } from "@rotorsoft/act";
import { describe, expect, vi } from "vitest";
import {
  courseStream,
  InvoiceCounter,
  Seats,
  Session,
  Student,
  sessionsStream,
  studentStream,
} from "./index.js";
import { acked, at, events, test } from "./setup.js";

const enroll = (student: string, course = "c1") => ({ course, student });

describe("course capacity", () => {
  test("enrolling takes a seat and a course in one commit, up to the capacity", async ({
    app,
  }) => {
    await app.do("Enroll", at("e-1"), enroll("s1"));
    await app.do("Enroll", at("e-2"), enroll("s2"));
    await expect(
      app.do("Enroll", at("e-3"), enroll("s3"))
    ).rejects.toBeInstanceOf(PreconditionError);
    expect((await app.load(Seats, courseStream("c1"))).state.taken).toBe(2);
    expect(await events("e-3")).toEqual([]);
    expect(await events(studentStream("s3"))).toEqual([]);
  });

  test("racing for the last seats: exactly the capacity wins, the retries are refused", async ({
    app,
  }) => {
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((i) =>
        app.do("Enroll", at(`e-${i}`), enroll(`s${i}`))
      )
    );
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(3);
    for (const r of refused) expect(r.reason).toBeInstanceOf(PreconditionError);
    expect((await app.load(Seats, courseStream("c1"))).state.taken).toBe(2);
  });

  test("a lowered limit: those enrolled keep their seats, and new ones are refused", async ({
    app,
  }) => {
    await app.do("Enroll", at("e-1"), enroll("s1"));
    await app.do("Enroll", at("e-2"), enroll("s2"));
    await app.do("SetCapacity", at(courseStream("c1")), { capacity: 1 });
    expect((await app.load(Seats, courseStream("c1"))).state).toEqual({
      taken: 2,
      capacity: 1,
    });
    await expect(
      app.do("Enroll", at("e-3"), enroll("s3"))
    ).rejects.toBeInstanceOf(PreconditionError);

    // One leaving isn't enough: two students, one seat.
    await app.do("Drop", at("e-1"), {});
    await expect(
      app.do("Enroll", at("e-3"), enroll("s3"))
    ).rejects.toBeInstanceOf(PreconditionError);
    await app.do("Drop", at("e-2"), {});
    await app.do("Enroll", at("e-3"), enroll("s3"));
  });

  test("dropping frees the seat and the course, once", async ({ app }) => {
    await app.do("Enroll", at("e-1"), enroll("s1"));
    await app.do("Drop", at("e-1"), {});
    expect((await app.load(Seats, courseStream("c1"))).state.taken).toBe(0);
    expect((await app.load(Student, studentStream("s1"))).state.courses).toBe(
      0
    );
    await expect(app.do("Drop", at("e-1"), {})).rejects.toThrow(
      "the student is enrolled"
    );
  });

  test("a student's fourth course is refused by the schema, storing nothing anywhere", async ({
    app,
  }) => {
    for (const c of ["c1", "c2", "c3"])
      await app.do("Enroll", at(`e-${c}`), enroll("s1", c));
    await expect(
      app.do("Enroll", at("e-c4"), enroll("s1", "c4"))
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await events("e-c4")).toEqual([]);
    expect(await events(courseStream("c4"))).toEqual([]);
  });
});

describe("sessions per user", () => {
  const hour = () => Date.now() + 3_600_000;
  const open = (expiresAt = hour()) => ({ user: "u1", expiresAt });

  test("a fourth session is refused, and logging out frees a slot", async ({
    app,
  }) => {
    for (const s of [1, 2, 3])
      await app.do("OpenSession", at(`s-${s}`), open());
    await expect(
      app.do("OpenSession", at("s-4"), open())
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await events("s-4")).toEqual([]);

    await app.do("Logout", at("s-1"), {});
    expect(await events("s-1")).toEqual(["SessionStarted", "LoggedOut"]);
    await app.do("OpenSession", at("s-4"), open());
  });

  test("a logout frees its slot once", async ({ app }) => {
    await app.do("OpenSession", at("s-1"), open());
    await app.do("Logout", at("s-1"), {});
    await expect(app.do("Logout", at("s-1"), {})).rejects.toThrow(
      "the session is open"
    );
    expect(await events(sessionsStream("u1"))).toEqual([
      "SessionOpened",
      "SessionClosed",
    ]);
  });

  test("the timer frees a slot when the session expires", async ({ app }) => {
    await app.do("OpenSession", at("s-1"), open(Date.now() + 40));
    await vi.waitFor(
      async () =>
        expect((await app.load(Session, "s-1")).state.open).toBe(false),
      { timeout: 4_000, interval: 25 }
    );
    expect(await events("s-1")).toEqual(["SessionStarted", "SessionExpired"]);
    expect(await events(sessionsStream("u1"))).toEqual([
      "SessionOpened",
      "SessionClosed",
    ]);
  });

  test("the timer finds nothing to free after a logout", async ({ app }) => {
    const timer = acked(app, "expire-s-1");
    await app.do("OpenSession", at("s-1"), open(Date.now() + 40));
    await app.do("Logout", at("s-1"), {});
    await timer;
    expect(await events("s-1")).toEqual(["SessionStarted", "LoggedOut"]);
    expect(await events(sessionsStream("u1"))).toHaveLength(2);
  });
});

describe("gapless invoice numbers", () => {
  test("numbers concurrent bills 1..n with no gaps or repeats", async ({
    app,
  }) => {
    const bills = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((i) => app.do("IssueBill", at(`bill-${i}`), {}))
    );
    expect(bills.map(([b]) => b.state.number).sort()).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect((await app.load(InvoiceCounter, "invoices")).state.last).toBe(6);
  });
});
