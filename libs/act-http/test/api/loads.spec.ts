/**
 * The generated APIs over an action with `.loads`: a route returns its own
 * stream's snapshots, and a refusal or a lost race reaches the client with
 * the status, code and detail the API promises, whichever stream caused it.
 */
import { act, InMemoryStore, type Store, state } from "@rotorsoft/act";
import { fixture } from "@rotorsoft/act/test";
import { initTRPC } from "@trpc/server";
import { testClient } from "hono/testing";
import { assert, describe, expect, vi } from "vitest";
import { z } from "zod";
import { hono } from "../../src/hono/index.js";
import { openapi } from "../../src/openapi/index.js";
import { trpc } from "../../src/trpc/index.js";

const SeatTaken = z.object({ student: z.string() });
const Seats = state({ Seats: z.object({ taken: z.number() }) })
  .init(() => ({ taken: 0 }))
  .emits({ SeatTaken })
  .patch({ SeatTaken: (_, s) => ({ taken: s.taken + 1 }) })
  .on({ TakeSeat: SeatTaken })
  .emit("SeatTaken")
  .build();
const Enroll = z.object({ course: z.string(), student: z.string() });
const Enrollment = state({ Enrollment: Enroll })
  .init(() => ({ course: "", student: "" }))
  .emits({ Enrolled: Enroll })
  .on({ Enroll })
  .loads(Seats, (data) => data.course, ["SeatTaken"])
  .requires([
    {
      description: "the course has a free seat",
      holds: (_, __, ___, { Seats }) => Seats.taken < 1,
    },
  ])
  .emit((data) => [
    ["Enrolled", data],
    ["SeatTaken", { student: data.student }],
  ])
  .build();

const Move = z.object({
  student: z.string(),
  from: z.string(),
  to: z.string(),
});
const Account = state({ Account: z.object({ moved: z.number() }) })
  .init(() => ({ moved: 0 }))
  .emits({ Debited: z.object({}), Credited: z.object({}) })
  .patch({
    Debited: (_, s) => ({ moved: s.moved + 1 }),
    Credited: (_, s) => ({ moved: s.moved + 1 }),
  })
  .build();
const Transfer = state({ Transfer: Move })
  .init(() => ({ student: "", from: "", to: "" }))
  .emits({ Transferred: Move })
  .on({ Transfer: Move })
  .loads(Account, (data) => data.from, ["Debited"], "from")
  .loads(Account, (data) => data.to, ["Credited"], "to")
  .emit((data) => [
    ["Transferred", data],
    ["Debited", {}],
    ["Credited", {}],
  ])
  .build();

let db: Store;
const test = fixture(
  act()
    .withState(Seats)
    .withState(Enrollment)
    .withState(Account)
    .withState(Transfer),
  {
    store: () => (db = new InMemoryStore()),
  }
);
const actor = { id: "a", name: "a" };
const options = {
  actor: () => actor,
  stream: (_action: string, input: { student: string }, _ctx: unknown) =>
    `enrollment-${input.student}`,
};
const body = (student: string) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ course: "c1", student }),
});
// Commits a rival to the course right before the next commit runs.
const rival_on_course = () => {
  const commit = db.commit.bind(db);
  vi.spyOn(db, "commit").mockImplementationOnce(async (...args) => {
    await commit(
      [
        {
          stream: "c1",
          msgs: [{ name: "SeatTaken", data: { student: "rival" } }],
        },
      ],
      { correlation: "rival", causation: {} }
    );
    return commit(...args);
  });
};

describe("hono over .loads", () => {
  test("returns only the action's own snapshots", async ({ app }) => {
    const client = testClient(hono(app, options));
    const res = await client.api.actions.Enroll.$post({
      json: { course: "c1", student: "ann" },
    });
    const snapshots = await res.json();
    assert(Array.isArray(snapshots));
    expect(snapshots.map((s) => s.event?.name)).toEqual(["Enrolled"]);
    expect((await app.load(Seats, "c1")).state.taken).toBe(1);
  });

  test("a rule over the loaded state answers 409, naming the action and the rule", async ({
    app,
  }) => {
    await app.do("TakeSeat", { stream: "c1", actor }, { student: "x" });
    const res = await hono(app, options).request(
      "/api/actions/Enroll",
      body("ann")
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "PreconditionError",
      code: "PRECONDITION",
      detail: "Enroll failed precondition: the course has a free seat",
    });
  });

  test("a transfer to the same account answers 409", async ({ app }) => {
    const res = await hono(app, options).request("/api/actions/Transfer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ student: "t-1", from: "a", to: "a" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "PreconditionError",
      code: "PRECONDITION",
      detail: 'Transfer failed precondition: loads stream "a" twice',
    });
    expect(await db.query(() => {}, { stream: "a" })).toBe(0);
  });

  test("a rival on the loaded stream answers 412, naming that stream", async ({
    app,
  }) => {
    rival_on_course();
    const res = await hono(app, options).request(
      "/api/actions/Enroll",
      body("ann")
    );
    expect(res.status).toBe(412);
    const error = await res.json();
    expect(error.code).toBe("CONCURRENCY");
    expect(error.detail).toContain('"c1.SeatTaken"');
    expect(error.detail).toContain("Expected version -1");
  });
});

describe("trpc over .loads", () => {
  const t = initTRPC.context<object>().create();

  test("maps a refusal and a lost race to their codes", async ({ app }) => {
    const call = t.createCallerFactory(trpc(app, options))({});
    const enroll = () => call.Enroll({ course: "c1", student: "ann" });

    rival_on_course();
    await expect(enroll()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining('"c1.SeatTaken"'),
    });
    await expect(enroll()).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Enroll failed precondition: the course has a free seat",
    });
  });
});

describe("openapi over .loads", () => {
  test("describes the refusal and the lost race on the route", ({ app }) => {
    const doc = openapi(app, { info: { title: "t", version: "1" } });
    const responses = doc.paths["/api/actions/Enroll"].post?.responses;
    expect(responses?.["409"]).toMatchObject({
      description: expect.stringContaining("A precondition refused"),
    });
    expect(responses?.["412"]).toMatchObject({
      description: expect.stringMatching(
        /moved since it was loaded.*on any stream/
      ),
    });
  });
});
