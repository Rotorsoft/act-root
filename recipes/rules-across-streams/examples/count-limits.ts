/**
 * A limit is a state with a count, one stream per thing being limited. An
 * action that takes a slot loads the count and lists the event, so a lost race
 * fails the whole commit and its retry sees the new count.
 */
import { slice, state, ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";

const SYSTEM = { id: "system", name: "rules" };

// ── Course capacity and a student's maximum courses ─────────────────────

/**
 * The capacity can be lowered below the seats already taken: the students
 * enrolled keep their seats, and only new ones are refused. So the limit is a
 * precondition on `Enroll`, and the schema can't say `taken <= capacity`.
 */
export const Seats = state({
  Seats: z.object({ taken: z.number().min(0), capacity: z.number().min(0) }),
})
  .init(() => ({ taken: 0, capacity: 2 }))
  .emits({
    SeatTaken: ZodEmpty,
    SeatFreed: ZodEmpty,
    CapacitySet: z.object({ capacity: z.number().min(0) }),
  })
  .patch({
    SeatTaken: (_, state) => ({ taken: state.taken + 1 }),
    SeatFreed: (_, state) => ({ taken: state.taken - 1 }),
    CapacitySet: ({ data }) => ({ capacity: data.capacity }),
  })
  .on({ SetCapacity: z.object({ capacity: z.number().min(0) }) })
  .emit("CapacitySet")
  .build();

/** This limit never moves, so the schema holds it whichever action emits. */
export const Student = state({
  Student: z.object({ courses: z.number().min(0).max(3) }),
})
  .init(() => ({ courses: 0 }))
  .emits({ CourseAdded: ZodEmpty, CourseDropped: ZodEmpty })
  .patch({
    CourseAdded: (_, state) => ({ courses: state.courses + 1 }),
    CourseDropped: (_, state) => ({ courses: state.courses - 1 }),
  })
  .build();

export const courseStream = (course: string) => `course-${course}`;
export const studentStream = (student: string) => `student-${student}`;

const Enroll = z.object({ course: z.string(), student: z.string() });

export const Enrollment = state({
  Enrollment: Enroll.extend({ active: z.boolean() }),
})
  .init(() => ({ course: "", student: "", active: false }))
  .emits({ Enrolled: Enroll, Dropped: ZodEmpty })
  .patch({
    Enrolled: ({ data }) => ({ ...data, active: true }),
    Dropped: () => ({ active: false }),
  })
  .on({ Enroll }, { maxRetries: 8 })
  .loads(Seats, (data) => courseStream(data.course), ["SeatTaken"])
  .loads(Student, (data) => studentStream(data.student), ["CourseAdded"])
  .requires([
    {
      description: "the course has a free seat",
      holds: (_, __, ___, { Seats }) => Seats.taken < Seats.capacity,
    },
  ])
  .emit((data) => [
    ["Enrolled", data],
    ["SeatTaken", {}],
    ["CourseAdded", {}],
  ])
  .on({ Drop: ZodEmpty }, { maxRetries: 8 })
  .loads(Seats, (_, state) => courseStream(state.course), ["SeatFreed"])
  .loads(Student, (_, state) => studentStream(state.student), ["CourseDropped"])
  .requires([
    {
      description: "the student is enrolled",
      holds: (_, state) => state.active,
    },
  ])
  .emit(() => [
    ["Dropped", {}],
    ["SeatFreed", {}],
    ["CourseDropped", {}],
  ])
  .build();

// ── Sessions per user, freed at logout or by a timer ────────────────────

export const UserSessions = state({
  UserSessions: z.object({ active: z.number().min(0).max(3) }),
})
  .init(() => ({ active: 0 }))
  .emits({ SessionOpened: ZodEmpty, SessionClosed: ZodEmpty })
  .patch({
    SessionOpened: (_, state) => ({ active: state.active + 1 }),
    SessionClosed: (_, state) => ({ active: state.active - 1 }),
  })
  .build();

export const sessionsStream = (user: string) => `sessions-${user}`;

const OpenSession = z.object({ user: z.string(), expiresAt: z.number() });

export const Session = state({
  Session: z.object({ user: z.string(), open: z.boolean() }),
})
  .init(() => ({ user: "", open: false }))
  .emits({
    SessionStarted: OpenSession,
    LoggedOut: ZodEmpty,
    SessionExpired: ZodEmpty,
  })
  .patch({
    SessionStarted: ({ data }) => ({ user: data.user, open: true }),
    LoggedOut: () => ({ open: false }),
    SessionExpired: () => ({ open: false }),
  })
  .on({ OpenSession }, { maxRetries: 4 })
  .loads(UserSessions, (data) => sessionsStream(data.user), ["SessionOpened"])
  .emit((data) => [
    ["SessionStarted", data],
    ["SessionOpened", {}],
  ])
  .on({ Logout: ZodEmpty }, { maxRetries: 4 })
  .loads(UserSessions, (_, state) => sessionsStream(state.user), [
    "SessionClosed",
  ])
  .requires([
    { description: "the session is open", holds: (_, state) => state.open },
  ])
  .emit(() => [
    ["LoggedOut", {}],
    ["SessionClosed", {}],
  ])
  .on({ ExpireSession: ZodEmpty }, { maxRetries: 4 })
  .loads(UserSessions, (_, state) => sessionsStream(state.user), [
    "SessionClosed",
  ])
  .requires([
    { description: "the session is open", holds: (_, state) => state.open },
  ])
  .emit(() => [
    ["SessionExpired", {}],
    ["SessionClosed", {}],
  ])
  .build();

/** When the timer comes due, a session already logged out has nothing to free. */
export const SessionTimers = slice()
  .withState(Session)
  .withState(UserSessions)
  .on("SessionStarted")
  .defer((event) => ({ at: new Date(event.data.expiresAt) }))
  .do(async function expireSession(event, _target, app) {
    const { state } = await app.load("Session", event.stream);
    if (!state.open) return;
    await app.do("ExpireSession", { stream: event.stream, actor: SYSTEM }, {});
  })
  .to((event) => ({ target: `expire-${event.stream}`, source: event.stream }))
  .build();

// ── Gapless invoice numbers ─────────────────────────────────────────────

export const InvoiceCounter = state({
  InvoiceCounter: z.object({ last: z.number() }),
})
  .init(() => ({ last: 0 }))
  .emits({ NumberIssued: z.object({ number: z.number() }) })
  .patch({ NumberIssued: ({ data }) => ({ last: data.number }) })
  .build();

export const Bill = state({ Bill: z.object({ number: z.number() }) })
  .init(() => ({ number: 0 }))
  .emits({ Billed: z.object({ number: z.number() }) })
  .on({ IssueBill: ZodEmpty }, { maxRetries: 16 })
  .loads(InvoiceCounter, () => "invoices", ["NumberIssued"])
  .emit((_, __, ___, { InvoiceCounter }) => {
    const number = InvoiceCounter.last + 1;
    return [
      ["Billed", { number }],
      ["NumberIssued", { number }],
    ];
  })
  .build();
