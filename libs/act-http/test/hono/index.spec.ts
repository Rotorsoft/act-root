/**
 * Adapter-generated Hono REST surface for `@rotorsoft/act-http/hono`.
 * Mirrors the trpc sibling's coverage shape: cross-action
 * emission, the internal actor middleware, stream extraction,
 * expected-version threading, idempotency dedup, error mapping for
 * all known framework errors plus the unknown / non-Error throw
 * paths. Round-trips run through `app.request()` so no live server
 * is needed.
 */
import { act, state, ZodEmpty } from "@rotorsoft/act";
import { fixture } from "@rotorsoft/act/test";
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { Hono } from "hono";
import { testClient } from "hono/testing";
import { assert, describe, expect, vi } from "vitest";
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
  actor: (c) => ({
    id: c.req.header("x-user-id") ?? "u-1",
    name: c.req.header("x-user-name") ?? "alice",
  }),
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
    const api = hono(app, default_options());
    // Hono registers each route entry once per `app.post(...)` call;
    // dedupe so the assertion is order/duplicate-insensitive.
    const paths = Array.from(
      new Set(api.routes.filter((r) => r.method === "POST").map((r) => r.path))
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
    const api = hono(app, default_options());

    const res = await testClient(api).api.actions.PressKey.$post(
      { json: { key: "5" } },
      { headers: make_headers() }
    );
    assert(res.status === 200);
    const snapshots = await res.json();
    expect(snapshots[0].event?.name).toBe("KeyPressed");
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
    const api = hono(app, { ...default_options(), basePath: "/v1" });
    const res = await testClient(api).v1.actions.PressKey.$post(
      { json: { key: "5" } },
      { headers: make_headers() }
    );
    expect(res.status).toBe(200);
  });

  test("body that fails Zod validation returns 422 with the ApiError envelope (matches the in-do ValidationError path)", async ({
    app,
  }) => {
    const api = hono(app, default_options());
    // Empty key violates `.min(1)`. The custom zValidator hook funnels
    // the failure through the shared ApiError envelope at 422 — the same
    // status/shape an in-do ValidationError maps to (ERROR_MAP.ValidationError
    // = 422), so a client parsing ApiError sees one shape for both.
    const res = await testClient(api).api.actions.PressKey.$post(
      { json: { key: "" } },
      { headers: make_headers() }
    );
    assert(res.status === 422);
    const body = await res.json();
    expect(body.error).toBe("ValidationError");
    expect(body.code).toBe("VALIDATION");
    expect(typeof body.detail).toBe("string");
  });

  test("a JSON body that doesn't parse gets the same 422 ApiError envelope", async ({
    app,
  }) => {
    const api = hono(app, default_options());
    const res = await api.request("/api/actions/PressKey", {
      method: "POST",
      headers: make_headers(),
      body: "{bad",
    });
    assert(res.status === 422);
    // A body that isn't JSON can't go through the typed client.
    expect(await res.json()).toMatchObject({
      error: "ValidationError",
      code: "VALIDATION",
    });
  });

  describe("expectedVersion (optimistic concurrency)", () => {
    test("threads the resolved value through Target.expectedVersion", async ({
      app,
    }) => {
      const do_spy = vi.spyOn(app, "do").mockResolvedValueOnce([]);
      const api = hono(app, {
        ...default_options(),
        expectedVersion: (_action, _input, c) => {
          const v = c.req.header("if-match");
          return v === undefined ? undefined : Number.parseInt(v, 10);
        },
      });
      await testClient(api).api.actions.PressKey.$post(
        { json: { key: "5" } },
        { headers: make_headers({ "if-match": "7" }) }
      );
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

    test("undefined resolver result leaves expectedVersion off the target", async ({
      app,
    }) => {
      const do_spy = vi.spyOn(app, "do").mockResolvedValueOnce([]);
      const api = hono(app, {
        ...default_options(),
        expectedVersion: () => undefined,
      });
      await testClient(api).api.actions.PressKey.$post(
        { json: { key: "5" } },
        { headers: make_headers() }
      );
      expect(do_spy).toHaveBeenCalledWith(
        "PressKey",
        { stream: "tenant-acme", actor: { id: "u-1", name: "alice" } },
        { key: "5" }
      );
    });
  });

  // Each framework error's status and code is pinned once in
  // api/errors.spec.ts; this proves the routes go through toApiError.
  describe("framework error mapping (via toApiError)", () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly throws: () => Error;
      readonly status: number;
      readonly code: string;
    }> = [
      {
        label: "unknown Error → 500 / INTERNAL (with detail)",
        throws: () => new Error("disk on fire"),
        status: 500,
        code: "INTERNAL",
      },
    ];

    for (const { label, throws, status, code } of cases) {
      test(label, async ({ app }) => {
        const api = hono(app, default_options());
        vi.spyOn(app, "do").mockRejectedValueOnce(throws());
        const res = await testClient(api).api.actions.PressKey.$post(
          { json: { key: "5" } },
          { headers: make_headers() }
        );
        expect(res.status).toBe(status);
        assert(res.status !== 200);
        const body = await res.json();
        expect(body.code).toBe(code);
      });
    }

    test("non-Error throws still return 500 with no detail leak", async ({
      app,
    }) => {
      const api = hono(app, default_options());
      vi.spyOn(app, "do").mockRejectedValueOnce("not-an-error-instance");
      const res = await testClient(api).api.actions.PressKey.$post(
        { json: { key: "5" } },
        { headers: make_headers() }
      );
      assert(res.status === 500);
      const body = await res.json();
      expect(body.code).toBe("INTERNAL");
      expect(body.detail).toBeUndefined();
    });
  });

  describe("idempotency", () => {
    test("fresh key dispatches and returns the snapshots", async ({ app }) => {
      const api = hono(app, {
        ...default_options(),
        idempotency: { store: new InMemoryIdempotencyStore() },
      });
      const res = await testClient(api).api.actions.PressKey.$post(
        { json: { key: "7" } },
        { headers: make_headers({ "idempotency-key": "fresh-1" }) }
      );
      assert(res.status === 200);
      const snapshots = await res.json();
      expect(snapshots[0].event?.name).toBe("KeyPressed");
    });

    test("missing Idempotency-Key returns 400", async ({ app }) => {
      const api = hono(app, {
        ...default_options(),
        idempotency: { store: new InMemoryIdempotencyStore() },
      });
      const res = await testClient(api).api.actions.PressKey.$post(
        { json: { key: "8" } },
        { headers: make_headers() }
      );
      assert(res.status === 400);
      const body = await res.json();
      expect(body.code).toBe("BAD_REQUEST");
    });

    test("custom keyFrom overrides the default header lookup", async ({
      app,
    }) => {
      const api = hono(app, {
        ...default_options(),
        idempotency: {
          store: new InMemoryIdempotencyStore(),
          keyFrom: (c) => c.req.header("x-trace-id"),
        },
      });
      const res = await testClient(api).api.actions.PressKey.$post(
        { json: { key: "9" } },
        { headers: make_headers({ "x-trace-id": "trace-abc" }) }
      );
      expect(res.status).toBe(200);
    });

    test("duplicate claim returns 409", async ({ app }) => {
      const store = new InMemoryIdempotencyStore();
      const api = hono(app, {
        ...default_options(),
        idempotency: { store },
      });
      const headers = make_headers({ "idempotency-key": "dup-1" });
      await testClient(api).api.actions.PressKey.$post(
        { json: { key: "1" } },
        { headers: headers }
      );
      const res = await testClient(api).api.actions.PressKey.$post(
        { json: { key: "1" } },
        { headers: headers }
      );
      assert(res.status === 409);
      const body = await res.json();
      expect(body.code).toBe("CONFLICT");
    });

    test("sees an in-flight original through another generator on the same store", async ({
      app,
    }) => {
      let finish!: () => void;
      const parked = new Promise<never>((_, reject) => {
        finish = () => reject(new Error("done"));
      });
      vi.spyOn(app, "do").mockImplementationOnce(() => parked);
      const store = new InMemoryIdempotencyStore();
      const a = hono(app, {
        ...default_options(),
        idempotency: { store },
      });
      const b = hono(app, {
        ...default_options(),
        idempotency: { store },
      });
      const send = (api: typeof a) =>
        testClient(api).api.actions.PressKey.$post(
          { json: { key: "5" } },
          { headers: make_headers({ "idempotency-key": "shared-1" }) }
        );
      const original = send(a);
      expect((await send(b)).status).toBe(503);
      finish();
      await original;
    });

    test("a duplicate of a still-running request gets a retryable 503, and is not lost when the original fails", async ({
      app,
    }) => {
      // The original parks inside app.do, then fails: a slow downstream
      // the client timed out on and retried while it was still running.
      let fail!: () => void;
      const parked = new Promise<never>((_, reject) => {
        fail = () => reject(new Error("downstream down"));
      });
      const do_spy = vi.spyOn(app, "do").mockImplementationOnce(() => parked);
      const api = hono(app, {
        ...default_options(),
        idempotency: { store: new InMemoryIdempotencyStore() },
      });
      const send = () =>
        testClient(api).api.actions.PressKey.$post(
          { json: { key: "5" } },
          { headers: make_headers({ "idempotency-key": "slow-1" }) }
        );

      const original = send();
      const duplicate = await send();
      assert(duplicate.status === 503);
      expect(duplicate.headers.get("retry-after")).toBe("1");
      expect((await duplicate.json()).code).toBe("IN_FLIGHT");

      fail();
      expect((await original).status).toBe(500);

      // The client retries as told, and the action runs this time.
      const retry = await send();
      expect(retry.status).toBe(200);
      expect(do_spy).toHaveBeenCalledTimes(2);
      // Once it committed, a further duplicate is a settled one.
      expect((await send()).status).toBe(409);
    });
  });

  describe("authenticated (standalone export)", () => {
    test("stashes the resolved actor under c.get('actor')", async () => {
      const api = new Hono<{
        Variables: { actor: { id: string; name: string } };
      }>();
      api.use(
        "*",
        authenticated((c) => ({ id: c.req.header("x-uid")!, name: "user" }))
      );
      api.get("/me", (c) => c.json(c.get("actor")));

      const res = await api.request("/me", { headers: { "x-uid": "alice" } });
      assert(res.status === 200);
      expect(await res.json()).toEqual({ id: "alice", name: "user" });
    });

    test("extractor errors surface as 401 with ApiError envelope", async () => {
      // Mounted on the route, so the typed client sees the 401.
      const api = new Hono().get(
        "/me",
        authenticated(() => {
          throw new Error("no token");
        }),
        (c) => c.json(c.get("actor"), 200)
      );

      const res = await testClient(api).me.$get();
      assert(res.status === 401);
      const body = await res.json();
      expect(body.code).toBe("UNAUTHORIZED");
      expect(body.detail).toBe("no token");
    });

    test("non-Error extractor throws still return 401 (no detail leak)", async () => {
      const api = new Hono().get(
        "/me",
        authenticated(() => {
          throw "raw-string-throw";
        }),
        (c) => c.text("ok", 200)
      );

      const res = await testClient(api).me.$get();
      assert(res.status === 401);
      const body = await res.json();
      expect(body.code).toBe("UNAUTHORIZED");
      expect(body.detail).toBeUndefined();
    });
  });
});

describe("action input is parsed once", () => {
  // A transform that counts its runs and appends "!" — a second parse of
  // the first parse's output would show up as two runs and "a!!".
  let parses = 0;
  const Shout = state({ Shout: z.object({ text: z.string() }) })
    .init(() => ({ text: "" }))
    .emits({ Shouted: z.object({ text: z.string() }) })
    .patch({ Shouted: ({ data }) => ({ text: data.text }) })
    .on({
      Shout: z.object({
        text: z.string().transform((s) => {
          parses++;
          return `${s}!`;
        }),
      }),
    })
    .emit((a) => ["Shouted", { text: a.text }])
    .build();
  const shout_test = fixture(act().withState(Shout));

  shout_test(
    "runs a transforming schema once, and resolvers see the parsed value",
    async ({ app }) => {
      parses = 0;
      const seen: unknown[] = [];
      const api = hono(app, {
        ...default_options(),
        stream: (_action, input) => {
          seen.push(input);
          return "shout-1";
        },
      });
      const res = await testClient(api).api.actions.Shout.$post(
        { json: { text: "a" } },
        { headers: make_headers() }
      );
      assert(res.status === 200);
      const body = (await res.json()) as Array<{ state: { text: string } }>;
      expect(body[0].state.text).toBe("a!");
      expect(seen).toEqual([{ text: "a!" }]);
      // once by the route's validator, once by app.do — never on its own output
      expect(parses).toBe(2);
    }
  );

  shout_test(
    "runs a transforming schema once on the idempotent path",
    async ({ app }) => {
      parses = 0;
      const api = hono(app, {
        ...default_options(),
        idempotency: { store: new InMemoryIdempotencyStore() },
      });
      const res = await testClient(api).api.actions.Shout.$post(
        { json: { text: "a" } },
        { headers: make_headers({ "idempotency-key": "shout-k" }) }
      );
      const body = (await res.json()) as Array<{ state: { text: string } }>;
      expect(body[0].state.text).toBe("a!");
    }
  );
});

describe("the action body follows the request's Content-Type", () => {
  const Note = state({ Note: z.object({ note: z.string() }) })
    .init(() => ({ note: "none" }))
    .emits({ Noted: z.object({ note: z.string().optional() }) })
    .patch({ Noted: ({ data }) => ({ note: data.note ?? "none" }) })
    .on({ jot: z.object({ note: z.string().optional() }) })
    .emit((a) => ["Noted", a])
    .build();
  const note_test = fixture(act().withState(Note).withState(Calculator));
  const seen: unknown[] = [];
  const opts = (): HonoOptions => ({
    ...default_options(),
    stream: (_action, input) => {
      seen.push(input);
      return "note-1";
    },
  });

  note_test(
    "an empty request with no Content-Type is accepted",
    async ({ app }) => {
      const res = await hono(app, opts()).request("/api/actions/Clear", {
        method: "POST",
        headers: { "x-user-id": "u-1", "x-user-name": "alice" },
      });
      expect(res.status).toBe(200);
    }
  );

  note_test(
    "a non-JSON body is ignored by the resolvers and app.do alike",
    async ({ app }) => {
      seen.length = 0;
      const res = await hono(app, opts()).request("/api/actions/jot", {
        method: "POST",
        headers: { "content-type": "text/plain", "x-user-id": "u-1" },
        body: JSON.stringify({ note: "hello" }),
      });
      const body = (await res.json()) as Array<{ state: { note: string } }>;
      expect(seen).toEqual([{}]);
      expect(body[0].state.note).toBe("none");
    }
  );

  note_test("a JSON body with parameters reaches both", async ({ app }) => {
    seen.length = 0;
    const res = await hono(app, opts()).request("/api/actions/jot", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-user-id": "u-1",
      },
      body: JSON.stringify({ note: "hello" }),
    });
    const body = (await res.json()) as Array<{ state: { note: string } }>;
    expect(seen).toEqual([{ note: "hello" }]);
    expect(body[0].state.note).toBe("hello");
  });
});
