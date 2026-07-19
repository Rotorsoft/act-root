/**
 * OpenAPI 3.1 document emitter for `@rotorsoft/act-http/openapi`
 * (#845). Pure-data emit — no live server, no Hono runtime — so
 * tests assert directly on the returned doc structure plus a stable
 * snapshot for diff-based surface-change detection in CI.
 */
import { act, sensitive, state, ZodEmpty } from "@rotorsoft/act";
import { fixture } from "@rotorsoft/act/test";
import { describe, expect } from "vitest";
import { z } from "zod";
import { type OpenAPIOptions, openapi } from "../../src/openapi/index.js";

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

const base_options = (): OpenAPIOptions => ({
  info: { title: "Test API", version: "1.0.0" },
});

describe("openapi(app, options) — doc emitter", () => {
  test("emits a valid OpenAPI 3.1 envelope", ({ app }) => {
    const doc = openapi(app as never, base_options());
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toEqual({ title: "Test API", version: "1.0.0" });
    expect(doc.components.schemas.ApiError).toBeDefined();
    expect(doc.components.schemas.SnapshotArray).toBeDefined();
    expect(doc.components.responses.ApiError).toBeDefined();
  });

  test("emits one POST operation per registered action under basePath", ({
    app,
  }) => {
    const doc = openapi(app as never, base_options());
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual([
      "/api/actions/Clear",
      "/api/actions/OpenTicket",
      "/api/actions/PressKey",
    ]);
    for (const p of paths) {
      const op = doc.paths[p]?.post;
      expect(op).toBeDefined();
      expect(op?.tags).toEqual(["Actions"]);
      expect(op?.requestBody?.required).toBe(true);
    }
  });

  test("custom basePath flows through to every path", ({ app }) => {
    const doc = openapi(app as never, { ...base_options(), basePath: "/v2" });
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/v2/actions/Clear",
      "/v2/actions/OpenTicket",
      "/v2/actions/PressKey",
    ]);
  });

  test("derives request-body schemas from each action's Zod definition", ({
    app,
  }) => {
    const doc = openapi(app as never, base_options());
    const body = doc.paths["/api/actions/PressKey"]?.post?.requestBody?.content[
      "application/json"
    ]?.schema as {
      type: string;
      properties: { key: { type: string; minLength?: number } };
    };
    expect(body.type).toBe("object");
    expect(body.properties.key.type).toBe("string");
    expect(body.properties.key.minLength).toBe(1);
  });

  test("every error response points at the shared ApiError envelope", ({
    app,
  }) => {
    const doc = openapi(app as never, base_options());
    const responses = doc.paths["/api/actions/PressKey"]?.post?.responses;
    for (const code of ["400", "409", "410", "412", "422", "500"]) {
      const ref = responses?.[code] as { $ref?: string };
      expect(ref.$ref).toBe("#/components/responses/ApiError");
    }
    const success = responses?.["200"] as {
      description: string;
      content: { "application/json": { schema: { $ref: string } } };
    };
    expect(success.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/SnapshotArray"
    );
  });

  test("omits parameters block when no cross-cutting headers are toggled", ({
    app,
  }) => {
    const doc = openapi(app as never, base_options());
    const op = doc.paths["/api/actions/PressKey"]?.post;
    expect(op?.parameters).toBeUndefined();
  });

  test("documents Idempotency-Key when idempotency is enabled", ({ app }) => {
    const doc = openapi(app as never, {
      ...base_options(),
      idempotency: true,
    });
    const params = doc.paths["/api/actions/PressKey"]?.post?.parameters;
    expect(params).toBeDefined();
    const idempotency_param = params?.find((p) => p.name === "Idempotency-Key");
    expect(idempotency_param).toBeDefined();
    expect(idempotency_param?.in).toBe("header");
    // Required: the route 400s when idempotency is on and the header is absent,
    // so the doc must not advertise it as optional (#1287).
    expect(idempotency_param?.required).toBe(true);
  });

  test("documents If-Match when expectedVersion is enabled", ({ app }) => {
    const doc = openapi(app as never, {
      ...base_options(),
      expectedVersion: true,
    });
    const params = doc.paths["/api/actions/PressKey"]?.post?.parameters;
    expect(params).toBeDefined();
    const if_match = params?.find((p) => p.name === "If-Match");
    expect(if_match?.in).toBe("header");
    expect(if_match?.required).toBe(false);
  });

  test("documents both headers when both toggles are enabled", ({ app }) => {
    const doc = openapi(app as never, {
      ...base_options(),
      idempotency: true,
      expectedVersion: true,
    });
    const params = doc.paths["/api/actions/PressKey"]?.post?.parameters;
    expect(params?.map((p) => p.name).sort()).toEqual([
      "Idempotency-Key",
      "If-Match",
    ]);
  });

  test("threads servers array through", ({ app }) => {
    const doc = openapi(app as never, {
      ...base_options(),
      servers: [
        { url: "https://api.example.com", description: "prod" },
        { url: "https://{tenant}.api.example.com/{stage}" },
      ],
    });
    expect(doc.servers).toHaveLength(2);
    expect(doc.servers?.[0]?.url).toBe("https://api.example.com");
    expect(doc.servers?.[1]?.url).toBe(
      "https://{tenant}.api.example.com/{stage}"
    );
  });

  test("omits servers when not provided", ({ app }) => {
    const doc = openapi(app as never, base_options());
    expect(doc.servers).toBeUndefined();
  });

  test("strips $schema metadata from inline body schemas", ({ app }) => {
    const doc = openapi(app as never, base_options());
    const body = doc.paths["/api/actions/PressKey"]?.post?.requestBody?.content[
      "application/json"
    ]?.schema as Record<string, unknown>;
    expect(body.$schema).toBeUndefined();
  });

  test("deterministic — two emits with the same inputs are equal", ({
    app,
  }) => {
    const a = openapi(app as never, base_options());
    const b = openapi(app as never, base_options());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  describe("options validation", () => {
    test("throws on missing info.title", ({ app }) => {
      expect(() =>
        openapi(app as never, {
          info: { title: "", version: "1.0.0" },
        })
      ).toThrow(/title is required/);
    });

    test("throws on whitespace-only info.title", ({ app }) => {
      expect(() =>
        openapi(app as never, {
          info: { title: "   ", version: "1.0.0" },
        })
      ).toThrow(/title is required/);
    });

    test("throws on missing info.version", ({ app }) => {
      expect(() =>
        openapi(app as never, {
          info: { title: "API", version: "" },
        })
      ).toThrow(/version is required/);
    });

    test("throws on whitespace-only info.version", ({ app }) => {
      expect(() =>
        openapi(app as never, {
          info: { title: "API", version: "   " },
        })
      ).toThrow(/version is required/);
    });

    test("throws on invalid server url", ({ app }) => {
      expect(() =>
        openapi(app as never, {
          ...base_options(),
          servers: [{ url: "not a url" }],
        })
      ).toThrow(/invalid server url/);
    });

    test("accepts server urls with {variable} template syntax", ({ app }) => {
      expect(() =>
        openapi(app as never, {
          ...base_options(),
          servers: [{ url: "https://{tenant}.api.example.com" }],
        })
      ).not.toThrow();
    });

    test("handles brace-heavy input in linear time (no ReDoS)", ({ app }) => {
      // Catastrophic-backtracking-style input for the original `[^}]+`
      // pattern. The template-strip now uses `[^{}]+` to forbid nested
      // braces, eliminating the exponential-matching surface CodeQL
      // flagged. Whether the URL parses or not is orthogonal — the
      // assertion is that the call completes quickly under adversarial
      // input.
      const start = Date.now();
      try {
        openapi(app as never, {
          ...base_options(),
          servers: [{ url: `https://${"{".repeat(2000)}.example.com` }],
        });
      } catch {
        // Either outcome is fine — we just don't want this to hang.
      }
      // Linear regex + URL parse should finish well under 100ms even
      // on a slow CI runner; a backtracking regex would exceed seconds.
      expect(Date.now() - start).toBeLessThan(100);
    });

    test("throws on missing info entirely", ({ app }) => {
      expect(() =>
        openapi(app as never, { info: undefined } as unknown as OpenAPIOptions)
      ).toThrow(/title is required/);
    });
  });

  test("stable surface (snapshot)", ({ app }) => {
    const doc = openapi(app as never, {
      info: { title: "Calculator API", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      idempotency: true,
      expectedVersion: true,
    });
    expect(doc).toMatchSnapshot();
  });
});

// #1228 — action inputs marked `sensitive()` must be flagged in the
// emitted request schema so codegen / Swagger UI don't echo PII freely.
const Account = state({
  Account: z.object({ email: z.string(), name: z.string() }),
})
  .init(() => ({ email: "", name: "" }))
  .emits({ Registered: z.object({ email: z.string(), name: z.string() }) })
  .patch({
    Registered: ({ data }) => ({ email: data.email, name: data.name }),
  })
  .on({
    Register: z.object({
      email: sensitive(z.string().email()),
      name: z.string(),
    }),
  })
  .emit((a) => ["Registered", { email: a.email, name: a.name }])
  .build();

const sensitive_builder = act().withState(Account);
const sensitive_test = fixture(sensitive_builder);

describe("openapi — sensitive() request-field marking (#1228)", () => {
  sensitive_test(
    "annotates sensitive input fields writeOnly:true + format:password",
    ({ app }) => {
      const doc = openapi(app as never, base_options());
      const schema = doc.paths["/api/actions/Register"]?.post?.requestBody
        ?.content["application/json"]?.schema as {
        properties: Record<string, Record<string, unknown>>;
      };
      // The sensitive field carries the marking.
      expect(schema.properties.email.writeOnly).toBe(true);
      expect(schema.properties.email.format).toBe("password");
      // Non-sensitive fields are left untouched.
      expect(schema.properties.name.writeOnly).toBeUndefined();
      expect(schema.properties.name.format).not.toBe("password");
    }
  );
});
