/**
 * Adapter-generated Hono REST surface for `@rotorsoft/act-http/hono`
 * (#844). Mirrors the trpc sibling's coverage shape: cross-action
 * emission, the internal actor middleware, stream extraction,
 * expected-version threading, idempotency dedup, error mapping for
 * all known framework errors plus the unknown / non-Error throw
 * paths. Round-trips run through `app.request()` so no live server
 * is needed.
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
import { Hono } from "hono";
import { describe, expect, vi } from "vitest";
import { z } from "zod";
import { authenticated, type HonoOptions, hono } from "../../src/hono/index.js";

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

const default_options = (): HonoOptions => ({
  actor: (request) => {
    const c = request as {
      req: { header: (name: string) => string | undefined };
    };
    return {
      id: c.req.header("x-user-id") ?? "u-1",
      name: c.req.header("x-user-name") ?? "alice",
    };
  },
  stream: (_action, _input, c) =>
    `tenant-${c.req.header("x-tenant") ?? "acme"}`,
});

const make_headers = (
  overrides: Record<string, string> = {}
): Record<string, string> => ({
  "content-type": "application/json",
  "x-user-id": "u-1",
  "x-user-name": "alice",
  "x-tenant": "acme",
  ...overrides,
});

describe("hono(app, options) — generated REST surface", () => {
  test("emits one POST /actions/<name> per registered action", ({ app }) => {
    // Cast through `unknown` to reach Hono's `routes` array (the
    // structural surface the assertion below introspects).
    const api = hono(app as never, default_options()) as unknown as {
      routes: Array<{ method: string; path: string }>;
    };
    // Hono registers each route entry once per `app.post(...)` call;
    // dedupe so the assertion is order/duplicate-insensitive.
    const paths = Array.from(
      new Set(
        api.routes
          .filter((r: { method: string }) => r.method === "POST")
          .map((r: { path: string }) => r.path)
      )
    ).sort();
    expect(paths).toEqual([
      "/api/actions/Clear",
      "/api/actions/OpenTicket",
      "/api/actions/PressKey",
    ]);
  });

  test("threads actor (via internal middleware) and stream into app.do", async ({
    app,
  }) => {
    const do_spy = vi.spyOn(app, "do");
    const api = hono(app as never, default_options());

    const res = await api.request("/api/actions/PressKey", {
      method: "POST",
      headers: make_headers(),
      body: JSON.stringify({ key: "5" }),
    });
    expect(res.status).toBe(200);
    const snapshots = await res.json();
    expect(snapshots[0].event.name).toBe("KeyPressed");
    expect(do_spy).toHaveBeenCalledWith(
      "PressKey",
      {
        stream: "tenant-acme",
        actor: { id: "u-1", name: "alice" },
      },
      { key: "5" }
    );
  });

  test("mounts under a custom basePath", async ({ app }) => {
    const api = hono(app as never, { ...default_options(), basePath: "/v1" });
    const res = await api.request("/v1/actions/PressKey", {
      method: "POST",
      headers: make_headers(),
      body: JSON.stringify({ key: "5" }),
    });
    expect(res.status).toBe(200);
  });

  test("body that fails Zod validation returns 400 with detail (via zValidator)", async ({
    app,
  }) => {
    const api = hono(app as never, default_options());
    // Empty key violates `.min(1)`. zValidator short-circuits before
    // the handler runs; Hono's default for validation failures is 400.
    const res = await api.request("/api/actions/PressKey", {
      method: "POST",
      headers: make_headers(),
      body: JSON.stringify({ key: "" }),
    });
    expect(res.status).toBe(400);
  });

  describe("expectedVersion (optimistic concurrency)", () => {
    test("threads the resolved value through Target.expectedVersion", async ({
      app,
    }) => {
      const do_spy = vi.spyOn(app, "do").mockResolvedValueOnce([]);
      const api = hono(app as never, {
        ...default_options(),
        expectedVersion: (_action, _input, c) => {
          const v = c.req.header("if-match");
          return v === undefined ? undefined : Number.parseInt(v, 10);
        },
      });
      await api.request("/api/actions/PressKey", {
        method: "POST",
        headers: make_headers({ "if-match": "7" }),
        body: JSON.stringify({ key: "5" }),
      });
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

    test("undefined resolver result skips the check on the target", async ({
      app,
    }) => {
      const do_spy = vi.spyOn(app, "do").mockResolvedValueOnce([]);
      const api = hono(app as never, {
        ...default_options(),
        expectedVersion: () => undefined,
      });
      await api.request("/api/actions/PressKey", {
        method: "POST",
        headers: make_headers(),
        body: JSON.stringify({ key: "5" }),
      });
      expect(do_spy).toHaveBeenCalledWith(
        "PressKey",
        { stream: "tenant-acme", actor: { id: "u-1", name: "alice" } },
        { key: "5" }
      );
    });
  });

  describe("framework error mapping (via toApiError)", () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly throws: () => Error;
      readonly status: number;
      readonly code: string;
    }> = [
      {
        label: "ConcurrencyError → 412 / CONCURRENCY",
        throws: () => new ConcurrencyError("tenant-acme", 0, [], 1),
        status: 412,
        code: "CONCURRENCY",
      },
      {
        label: "InvariantError → 409 / INVARIANT",
        throws: () =>
          new InvariantError(
            "PressKey",
            { key: "5" },
            { stream: "tenant-acme", actor: { id: "u-1", name: "alice" } },
            {} as never,
            "calculator must be open"
          ),
        status: 409,
        code: "INVARIANT",
      },
      {
        label: "StreamClosedError → 410 / STREAM_CLOSED",
        throws: () => new StreamClosedError("tenant-acme"),
        status: 410,
        code: "STREAM_CLOSED",
      },
      {
        label: "NonRetryableError → 400 / NON_RETRYABLE",
        throws: () => new NonRetryableError("permanently busted"),
        status: 400,
        code: "NON_RETRYABLE",
      },
      {
        label: "ValidationError → 422 / VALIDATION",
        throws: () =>
          new ValidationError("PressKey", { key: "5" }, {
            issues: [],
          } as never),
        status: 422,
        code: "VALIDATION",
      },
      {
        label: "unknown Error → 500 / INTERNAL (with detail)",
        throws: () => new Error("disk on fire"),
        status: 500,
        code: "INTERNAL",
      },
    ];

    for (const { label, throws, status, code } of cases) {
      test(label, async ({ app }) => {
        const api = hono(app as never, default_options());
        vi.spyOn(app, "do").mockRejectedValueOnce(throws());
        const res = await api.request("/api/actions/PressKey", {
          method: "POST",
          headers: make_headers(),
          body: JSON.stringify({ key: "5" }),
        });
        expect(res.status).toBe(status);
        const body = await res.json();
        expect(body.code).toBe(code);
      });
    }

    test("non-Error throws still return 500 with no detail leak", async ({
      app,
    }) => {
      const api = hono(app as never, default_options());
      vi.spyOn(app, "do").mockRejectedValueOnce("not-an-error-instance");
      const res = await api.request("/api/actions/PressKey", {
        method: "POST",
        headers: make_headers(),
        body: JSON.stringify({ key: "5" }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe("INTERNAL");
      expect(body.detail).toBeUndefined();
    });
  });

  describe("idempotency", () => {
    test("fresh key dispatches and returns the snapshots", async ({ app }) => {
      const api = hono(app as never, {
        ...default_options(),
        idempotency: { store: new InMemoryIdempotencyStore() },
      });
      const res = await api.request("/api/actions/PressKey", {
        method: "POST",
        headers: make_headers({ "idempotency-key": "fresh-1" }),
        body: JSON.stringify({ key: "7" }),
      });
      expect(res.status).toBe(200);
      const snapshots = await res.json();
      expect(snapshots[0].event.name).toBe("KeyPressed");
    });

    test("missing Idempotency-Key returns 400", async ({ app }) => {
      const api = hono(app as never, {
        ...default_options(),
        idempotency: { store: new InMemoryIdempotencyStore() },
      });
      const res = await api.request("/api/actions/PressKey", {
        method: "POST",
        headers: make_headers(),
        body: JSON.stringify({ key: "8" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("BAD_REQUEST");
    });

    test("custom keyFrom overrides the default header lookup", async ({
      app,
    }) => {
      const api = hono(app as never, {
        ...default_options(),
        idempotency: {
          store: new InMemoryIdempotencyStore(),
          keyFrom: (c) => c.req.header("x-trace-id"),
        },
      });
      const res = await api.request("/api/actions/PressKey", {
        method: "POST",
        headers: make_headers({ "x-trace-id": "trace-abc" }),
        body: JSON.stringify({ key: "9" }),
      });
      expect(res.status).toBe(200);
    });

    test("duplicate claim returns 409", async ({ app }) => {
      const store = new InMemoryIdempotencyStore();
      const api = hono(app as never, {
        ...default_options(),
        idempotency: { store },
      });
      const headers = make_headers({ "idempotency-key": "dup-1" });
      await api.request("/api/actions/PressKey", {
        method: "POST",
        headers,
        body: JSON.stringify({ key: "1" }),
      });
      const res = await api.request("/api/actions/PressKey", {
        method: "POST",
        headers,
        body: JSON.stringify({ key: "1" }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("CONFLICT");
    });
  });

  describe("authenticated (standalone export)", () => {
    test("stashes the resolved actor under c.get('actor')", async () => {
      const api = new Hono<{
        Variables: { actor: { id: string; name: string } };
      }>();
      api.use(
        "*",
        authenticated((request) => ({
          id: (
            request as { req: { header: (n: string) => string | undefined } }
          ).req.header("x-uid")!,
          name: "user",
        }))
      );
      api.get("/me", (c) => c.json(c.get("actor")));

      const res = await api.request("/me", { headers: { "x-uid": "alice" } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "alice", name: "user" });
    });

    test("extractor errors surface as 401 with ApiError envelope", async () => {
      const api = new Hono<{
        Variables: { actor: { id: string; name: string } };
      }>();
      api.use(
        "*",
        authenticated(() => {
          throw new Error("no token");
        })
      );
      api.get("/me", (c) => c.json(c.get("actor")));

      const res = await api.request("/me");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("UNAUTHORIZED");
      expect(body.detail).toBe("no token");
    });

    test("non-Error extractor throws still return 401 (no detail leak)", async () => {
      const api = new Hono();
      api.use(
        "*",
        authenticated(() => {
          throw "raw-string-throw";
        })
      );
      api.get("/me", (c) => c.text("ok"));

      const res = await api.request("/me");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("UNAUTHORIZED");
      expect(body.detail).toBeUndefined();
    });
  });
});
