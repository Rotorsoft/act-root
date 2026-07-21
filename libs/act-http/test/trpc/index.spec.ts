/**
 * Adapter-generated tRPC router for `@rotorsoft/act-http/trpc` (#843).
 *
 * Uses an in-memory `Act` with two states (Calculator + Ticket) so the
 * cross-state action surface is observable: every action lands as a
 * top-level mutation, names stay unique across states (the framework
 * enforces this), and stream/actor resolution flows through the same
 * seams regardless of owning state.
 *
 * Runtime coverage: flat emission across states, the internal actor
 * middleware, stream extraction, idempotency dedup, error mapping
 * (validation / concurrency / unknown / non-Error throws). Type-level
 * coverage via `expectTypeOf` for procedure inputs.
 */
import {
  act,
  ConcurrencyError,
  InvariantError,
  NonRetryableError,
  StreamClosedError,
  state,
  ValidationError,
  ZodEmpty,
} from "@rotorsoft/act";
import { fixture } from "@rotorsoft/act/test";
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { initTRPC, TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/unstable-core-do-not-import";
import { describe, expect, expectTypeOf, vi } from "vitest";
import { z } from "zod";
import { toApiError } from "../../src/api/errors.js";
import { authenticated, type TrpcOptions, trpc } from "../../src/trpc/index.js";

const Calculator = state({
  Calculator: z.object({ display: z.string() }),
})
  .init(() => ({ display: "" }))
  .emits({
    KeyPressed: z.object({ key: z.string() }),
    Cleared: ZodEmpty,
  })
  .patch({
    KeyPressed: ({ data }, s) => ({ display: s.display + data.key }),
    Cleared: () => ({ display: "" }),
  })
  .on({ PressKey: z.object({ key: z.string().min(1) }) })
  .emit((a) => ["KeyPressed", { key: a.key }])
  .on({ Clear: ZodEmpty })
  .emit(() => ["Cleared", {}])
  .build();

const Ticket = state({
  Ticket: z.object({ title: z.string(), open: z.boolean() }),
})
  .init(() => ({ title: "", open: false }))
  .emits({ TicketOpened: z.object({ title: z.string() }) })
  .patch({
    TicketOpened: ({ data }) => ({ title: data.title, open: true }),
  })
  .on({ OpenTicket: z.object({ title: z.string() }) })
  .emit((a) => ["TicketOpened", { title: a.title }])
  .build();

const builder = act().withState(Calculator).withState(Ticket);

const test = fixture(builder);

type Ctx = {
  actorId: string;
  actorName: string;
  tenant: string;
  idempotencyKey?: string;
};

const default_options = (): TrpcOptions<Ctx> => ({
  actor: (ctx) => ({
    id: (ctx as Ctx).actorId,
    name: (ctx as Ctx).actorName,
  }),
  stream: async (_action, _input, ctx) => `tenant-${ctx.tenant}`,
});

const make_ctx = (overrides: Partial<Ctx> = {}): Ctx => ({
  actorId: "u-1",
  actorName: "alice",
  tenant: "acme",
  ...overrides,
});

// Caller shape under test — Record-indexed so we can dispatch any
// procedure by name without per-test typing. Each procedure returns
// the framework's `Snapshot[]` shape; the few fields the assertions
// reach for (`event.name`, `event.stream`) are spelled out
// structurally rather than via the framework's wider type so the
// test stays narrow.
type CallerSnapshot = {
  event: {
    name: string;
    stream: string;
    meta: {
      causation: { action?: { actor: { id: string; name: string } } };
    };
  };
  state: { display: string };
};
type AnyCaller = Record<string, (input?: unknown) => Promise<CallerSnapshot[]>>;

describe("trpc(app, options) — generated router", () => {
  test("emits one flat mutation per registered action across all states", ({
    app,
  }) => {
    const router = trpc<Ctx>(app as never, default_options());
    const def = (router as { _def: { procedures: Record<string, unknown> } })
      ._def.procedures;
    expect(Object.keys(def).sort()).toEqual([
      "Clear",
      "OpenTicket",
      "PressKey",
    ]);
  });

  test("each emitted procedure is callable as a top-level mutation", ({
    app,
  }) => {
    const router = trpc<Ctx>(app as never, default_options());
    const t = initTRPC.context<Ctx>().create();
    const caller = t.createCallerFactory(router)(
      make_ctx()
    ) as unknown as AnyCaller;
    expect(typeof caller.PressKey).toBe("function");
    expect(typeof caller.Clear).toBe("function");
    expect(typeof caller.OpenTicket).toBe("function");
  });

  test("threads actor (via internal middleware) and stream into app.do", async ({
    app,
  }) => {
    const do_spy = vi.spyOn(app, "do");
    const router = trpc<Ctx>(app as never, default_options());
    const t = initTRPC.context<Ctx>().create();
    const caller = t.createCallerFactory(router)(
      make_ctx()
    ) as unknown as AnyCaller;

    const snapshots = await caller.PressKey({ key: "5" });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].event.name).toBe("KeyPressed");
    expect(snapshots[0].event.stream).toBe("tenant-acme");
    expect(do_spy).toHaveBeenCalledWith(
      "PressKey",
      {
        stream: "tenant-acme",
        actor: { id: "u-1", name: "alice" },
      },
      { key: "5" }
    );
  });

  test("maps a malformed body to 422 UNPROCESSABLE_CONTENT (parity with Hono/OpenAPI)", async ({
    app,
  }) => {
    const router = trpc<Ctx>(app as never, default_options());
    const t = initTRPC.context<Ctx>().create();
    const caller = t.createCallerFactory(router)(
      make_ctx()
    ) as unknown as AnyCaller;

    // Empty key violates the action's `.min(1)` Zod constraint. The generator
    // validates in-resolver (not via tRPC's `.input()`, which would hardcode a
    // BAD_REQUEST 400), so the failure routes through `to_trpc_error` as the
    // same ValidationError a malformed `app.do` payload raises → 422, matching
    // the Hono/OpenAPI transports (#1295).
    try {
      await caller.PressKey({ key: "" });
      throw new Error("expected the malformed body to reject");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("UNPROCESSABLE_CONTENT");
      expect(getHTTPStatusCodeFromError(err as never)).toBe(422);
    }
  });

  describe("expectedVersion (optimistic concurrency)", () => {
    test("threads the resolved value through Target.expectedVersion", async ({
      app,
    }) => {
      const do_spy = vi.spyOn(app, "do").mockResolvedValueOnce([]);
      const router = trpc<Ctx>(app as never, {
        ...default_options(),
        expectedVersion: () => 7,
      });
      const t = initTRPC.context<Ctx>().create();
      const caller = t.createCallerFactory(router)(
        make_ctx()
      ) as unknown as AnyCaller;

      await caller.PressKey({ key: "5" });
      expect(do_spy).toHaveBeenCalledWith(
        "PressKey",
        {
          stream: "tenant-acme",
          actor: { id: "u-1", name: "alice" },
          expectedVersion: 7,
        },
        { key: "5" }
      );
    });

    test("undefined return value skips the check (no expectedVersion on target)", async ({
      app,
    }) => {
      const do_spy = vi.spyOn(app, "do").mockResolvedValueOnce([]);
      const router = trpc<Ctx>(app as never, {
        ...default_options(),
        expectedVersion: () => undefined,
      });
      const t = initTRPC.context<Ctx>().create();
      const caller = t.createCallerFactory(router)(
        make_ctx()
      ) as unknown as AnyCaller;

      await caller.PressKey({ key: "5" });
      expect(do_spy).toHaveBeenCalledWith(
        "PressKey",
        // No `expectedVersion` key — the target is the plain shape.
        { stream: "tenant-acme", actor: { id: "u-1", name: "alice" } },
        { key: "5" }
      );
    });
  });

  describe("framework error mapping (via toApiError)", () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly throws: () => Error;
      readonly code: string;
    }> = [
      {
        label: "ConcurrencyError → PRECONDITION_FAILED (412, matches Hono)",
        throws: () => new ConcurrencyError("tenant-acme", 0, [], 1),
        code: "PRECONDITION_FAILED",
      },
      {
        label: "InvariantError → CONFLICT (409)",
        throws: () =>
          new InvariantError(
            "PressKey",
            { key: "5" },
            { stream: "tenant-acme", actor: { id: "u-1", name: "alice" } },
            {} as never,
            "calculator must be open"
          ),
        code: "CONFLICT",
      },
      {
        label: "StreamClosedError → NOT_FOUND (410 Gone; tRPC has no 410)",
        throws: () => new StreamClosedError("tenant-acme"),
        code: "NOT_FOUND",
      },
      {
        label: "NonRetryableError → BAD_REQUEST (400)",
        throws: () => new NonRetryableError("permanently busted"),
        code: "BAD_REQUEST",
      },
      {
        label: "ValidationError → UNPROCESSABLE_CONTENT (422)",
        throws: () =>
          new ValidationError("PressKey", { key: "5" }, {
            issues: [],
          } as never),
        code: "UNPROCESSABLE_CONTENT",
      },
    ];

    for (const { label, throws, code } of cases) {
      test(label, async ({ app }) => {
        const router = trpc<Ctx>(app as never, default_options());
        const t = initTRPC.context<Ctx>().create();
        const caller = t.createCallerFactory(router)(
          make_ctx()
        ) as unknown as AnyCaller;
        vi.spyOn(app, "do").mockRejectedValueOnce(throws());
        await expect(caller.PressKey({ key: "5" })).rejects.toMatchObject({
          code,
        });
      });
    }
  });

  test("wraps unknown thrown values as INTERNAL_SERVER_ERROR", async ({
    app,
  }) => {
    const router = trpc<Ctx>(app as never, default_options());
    const t = initTRPC.context<Ctx>().create();
    const caller = t.createCallerFactory(router)(
      make_ctx()
    ) as unknown as AnyCaller;

    vi.spyOn(app, "do").mockRejectedValueOnce(new Error("disk on fire"));
    await expect(caller.PressKey({ key: "5" })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });

  test("non-Error throws still surface as TRPCError", async ({ app }) => {
    const router = trpc<Ctx>(app as never, default_options());
    const t = initTRPC.context<Ctx>().create();
    const caller = t.createCallerFactory(router)(
      make_ctx()
    ) as unknown as AnyCaller;

    vi.spyOn(app, "do").mockRejectedValueOnce("not-an-error-instance");
    await expect(caller.PressKey({ key: "5" })).rejects.toBeInstanceOf(
      TRPCError
    );
  });

  test("actor 'throw to deny' surfaces as UNAUTHORIZED (401), matching Hono (#1286)", async ({
    app,
  }) => {
    // The extractor denies with a plain Error. Before the fix this fell through
    // to_trpc_error → toApiError(500) → INTERNAL_SERVER_ERROR; Hono's
    // `authenticated` middleware returns 401. The guide promises they're
    // identical, so the generated router must map an extractor throw to
    // UNAUTHORIZED (401), preserving the message.
    const router = trpc<Ctx>(app as never, {
      ...default_options(),
      actor: () => {
        throw new Error("denied");
      },
    });
    const t = initTRPC.context<Ctx>().create();
    const caller = t.createCallerFactory(router)(
      make_ctx()
    ) as unknown as AnyCaller;
    const err = await caller.PressKey({ key: "5" }).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("UNAUTHORIZED");
    expect((err as TRPCError).message).toBe("denied");
    expect(getHTTPStatusCodeFromError(err as TRPCError)).toBe(401);
  });

  test("a non-Error actor deny still maps to UNAUTHORIZED (401)", async ({
    app,
  }) => {
    const router = trpc<Ctx>(app as never, {
      ...default_options(),
      actor: () => {
        throw "nope"; // non-Error throw
      },
    });
    const t = initTRPC.context<Ctx>().create();
    const caller = t.createCallerFactory(router)(
      make_ctx()
    ) as unknown as AnyCaller;
    const err = await caller.PressKey({ key: "5" }).catch((e) => e);
    expect((err as TRPCError).code).toBe("UNAUTHORIZED");
    expect(getHTTPStatusCodeFromError(err as TRPCError)).toBe(401);
  });

  // A client speaking both tRPC and Hono/OpenAPI must see the same HTTP status
  // for the same framework error (#1280). tRPC serializes each mapped code to a
  // status via getHTTPStatusCodeFromError; assert it equals what Hono/OpenAPI
  // produce through the shared `toApiError` table — the one unavoidable
  // exception is StreamClosedError (410 Gone), which tRPC has no code for and
  // surfaces as 404 Not Found.
  describe("cross-transport wire-status parity (#1280)", () => {
    const parity: ReadonlyArray<{
      label: string;
      throws: () => Error;
      trpcStatus: number;
      sameAsHono: boolean;
    }> = [
      {
        label: "ConcurrencyError",
        throws: () => new ConcurrencyError("tenant-acme", 0, [], 1),
        trpcStatus: 412,
        sameAsHono: true,
      },
      {
        label: "InvariantError",
        throws: () =>
          new InvariantError(
            "PressKey",
            { key: "5" },
            { stream: "tenant-acme", actor: { id: "u-1", name: "alice" } },
            {} as never,
            "calculator must be open"
          ),
        trpcStatus: 409,
        sameAsHono: true,
      },
      {
        label: "ValidationError",
        throws: () =>
          new ValidationError("PressKey", { key: "5" }, {
            issues: [],
          } as never),
        trpcStatus: 422,
        sameAsHono: true,
      },
      {
        label: "NonRetryableError",
        throws: () => new NonRetryableError("permanently busted"),
        trpcStatus: 400,
        sameAsHono: true,
      },
      {
        label: "StreamClosedError (410 → 404, the documented exception)",
        throws: () => new StreamClosedError("tenant-acme"),
        trpcStatus: 404,
        sameAsHono: false,
      },
    ];

    for (const { label, throws, trpcStatus, sameAsHono } of parity) {
      test(`${label} → tRPC HTTP ${trpcStatus}`, async ({ app }) => {
        const router = trpc<Ctx>(app as never, default_options());
        const t = initTRPC.context<Ctx>().create();
        const caller = t.createCallerFactory(router)(
          make_ctx()
        ) as unknown as AnyCaller;
        const thrown = throws();
        vi.spyOn(app, "do").mockRejectedValueOnce(thrown);
        const err = await caller.PressKey({ key: "5" }).catch((e) => e);
        expect(err).toBeInstanceOf(TRPCError);
        const wire = getHTTPStatusCodeFromError(err as TRPCError);
        expect(wire).toBe(trpcStatus);
        // Parity with the Hono/OpenAPI wire status via the shared table.
        const hono = toApiError(thrown).status;
        if (sameAsHono) {
          expect(wire).toBe(hono);
        } else {
          expect(hono).toBe(410); // Gone on REST
          expect(wire).toBe(404); // Not Found on tRPC — no 410 code
        }
      });
    }
  });

  describe("idempotency", () => {
    test("fresh key dispatches the handler and returns the snapshots", async ({
      app,
    }) => {
      const router = trpc<Ctx>(app as never, {
        ...default_options(),
        idempotency: {
          store: new InMemoryIdempotencyStore(),
          keyFrom: (ctx) => ctx.idempotencyKey,
        },
      });
      const t = initTRPC.context<Ctx>().create();
      const caller = t.createCallerFactory(router)(
        make_ctx({ idempotencyKey: "fresh-1" })
      ) as unknown as AnyCaller;

      const snapshots = await caller.PressKey({ key: "7" });
      expect(snapshots[0].event.name).toBe("KeyPressed");
    });

    test("missing key throws BAD_REQUEST", async ({ app }) => {
      const router = trpc<Ctx>(app as never, {
        ...default_options(),
        idempotency: {
          store: new InMemoryIdempotencyStore(),
          keyFrom: () => undefined,
        },
      });
      const t = initTRPC.context<Ctx>().create();
      const caller = t.createCallerFactory(router)(
        make_ctx()
      ) as unknown as AnyCaller;

      await expect(caller.PressKey({ key: "8" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });

    test("duplicate claim throws CONFLICT (original result not cached)", async ({
      app,
    }) => {
      const store = new InMemoryIdempotencyStore();
      const router = trpc<Ctx>(app as never, {
        ...default_options(),
        idempotency: {
          store,
          keyFrom: (ctx) => ctx.idempotencyKey,
        },
      });
      const t = initTRPC.context<Ctx>().create();
      const caller = t.createCallerFactory(router)(
        make_ctx({ idempotencyKey: "dup-1" })
      ) as unknown as AnyCaller;

      await caller.PressKey({ key: "1" });
      await expect(caller.PressKey({ key: "1" })).rejects.toMatchObject({
        code: "CONFLICT",
      });
    });
  });

  describe("authenticated (standalone export)", () => {
    test("injects the resolved actor onto downstream ctx", async () => {
      const t = initTRPC.context<{ uid: string }>().create();
      const authed = t.procedure.use(
        authenticated((ctx) => ({
          id: (ctx as { uid: string }).uid,
          name: `user-${(ctx as { uid: string }).uid}`,
        }))
      );
      // The middleware returns `any` to avoid the
      // `unstable-core-do-not-import` namespace dance — the per-call
      // ctx augmentation is real at runtime but invisible to tRPC's
      // inference, so the test casts to read `ctx.actor`.
      const router = t.router({
        whoami: authed.query(
          ({ ctx }) =>
            (ctx as unknown as { actor: { id: string; name: string } }).actor
        ),
      });
      const caller = t.createCallerFactory(router)({ uid: "alice" });
      expect(await caller.whoami()).toEqual({
        id: "alice",
        name: "user-alice",
      });
    });

    test("propagates errors thrown by the extractor", async () => {
      const t = initTRPC.context<{ uid?: string }>().create();
      const authed = t.procedure.use(
        authenticated((ctx) => {
          const c = ctx as { uid?: string };
          if (!c.uid)
            throw new TRPCError({
              code: "UNAUTHORIZED",
              message: "no uid in ctx",
            });
          return { id: c.uid, name: c.uid };
        })
      );
      const router = t.router({
        whoami: authed.query(({ ctx }) => (ctx as { actor?: unknown }).actor),
      });
      const caller = t.createCallerFactory(router)({});
      await expect(caller.whoami()).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });
  });

  test("infers procedure input types from the registered Zod schemas", () => {
    expectTypeOf<z.infer<typeof Calculator.actions.PressKey>>().toEqualTypeOf<{
      key: string;
    }>();
    expectTypeOf<z.infer<typeof Ticket.actions.OpenTicket>>().toEqualTypeOf<{
      title: string;
    }>();
  });
});
