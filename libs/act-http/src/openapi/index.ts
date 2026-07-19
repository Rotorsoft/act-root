/**
 * @packageDocumentation
 * @module act-http/openapi
 *
 * OpenAPI subpath for the auto-generated API epic (#835). Walks the
 * registry of a built `Act` once at function call and returns a
 * valid OpenAPI 3.1 document describing the same action surface the
 * Hono sibling at `@rotorsoft/act-http/hono` serves. The doc is
 * suitable for cross-language client codegen (Go, Python, Swift,
 * Kotlin, .NET), for serving over `/openapi.json` alongside a live
 * API, and for the broader OpenAPI tooling ecosystem (Postman,
 * Swagger UI, Redoc, schemathesis, API gateways).
 *
 * Usage:
 *
 * ```ts
 * import { openapi } from "@rotorsoft/act-http/openapi";
 *
 * const doc = openapi(app, {
 *   info: { title: "Wolfdesk API", version: "1.0.0" },
 *   servers: [{ url: "https://api.example.com" }],
 * });
 * // doc: OpenAPIDocument — valid OpenAPI 3.1 object
 * ```
 *
 * **Pure data emit.** No runtime dep on Hono or tRPC. The subpath is
 * consumable standalone for hosts that serve their API some other
 * way (Fastify, Lambda, edge) or that only want the doc for client
 * codegen. The emit walks the registry once at function call; cost
 * is linear in `N actions × M Zod fields each`, single-digit
 * milliseconds for a 100-endpoint registry.
 *
 * **Determinism.** Output is stable across runs given the same
 * registry — entries land in `Object.entries(app.registry.actions)`
 * iteration order, schemas come from the action's Zod definition,
 * and the rest of the doc is fixed content. CI can snapshot the
 * result to catch unintended API surface changes.
 *
 * The same shared utilities at `@rotorsoft/act-http/api` underwrite
 * cross-transport consistency: the `ApiError` envelope is referenced
 * once from `components.schemas`, every error response points at it,
 * and the same shape ships from the tRPC and Hono siblings at
 * runtime. A client speaking the doc and the live REST API sees one
 * envelope per framework error.
 *
 * **The doc describes the Hono surface, not tRPC.** tRPC's URL
 * shape (`POST /trpc/<procedure>`, JSON-RPC-style body framing,
 * batching) doesn't model cleanly as OpenAPI operations — and tRPC
 * consumers already share types directly via `typeof router`, so
 * OpenAPI buys them nothing. The path shape this emitter produces
 * (`POST <basePath>/actions/<name>`) matches the
 * `@rotorsoft/act-http/hono` sibling exactly: same default
 * `basePath`, same request/response shapes, same envelope. If the
 * operator overrides `basePath` on the Hono adapter, they pass the
 * same override here so the doc keeps matching the live routes by
 * construction. tRPC and Hono can run side-by-side at different
 * mount points on the same Act instance; the OpenAPI doc covers
 * the REST half only.
 */
import { pii_fields } from "@rotorsoft/act";
import { z } from "zod";

/**
 * Minimal OpenAPI 3.1 document type. The emitter targets the 3.1
 * spec; the type is intentionally a structural subset rather than
 * the full surface from `openapi-types` so callers can post-process
 * without fighting the type system. Cast to a fuller type from
 * `openapi-types` when downstream consumers need it.
 */
export type OpenAPIDocument = {
  readonly openapi: "3.1.0";
  readonly info: OpenAPIInfo;
  readonly servers?: ReadonlyArray<OpenAPIServer>;
  readonly paths: Record<string, OpenAPIPathItem>;
  readonly components: OpenAPIComponents;
};

/**
 * Per-call options for {@link openapi}. The host supplies the
 * document-shape fields the registry can't derive (title, version,
 * servers) and toggles for the cross-cutting headers that the live
 * REST API may accept.
 *
 * - `info` — required. `title` and `version` must be non-empty;
 *   `info` may carry any other top-level OpenAPI info fields.
 * - `servers` — optional. Each entry's `url` may contain
 *   `{variable}` template syntax; bare URLs are validated through
 *   `URL`'s parser and reject malformed inputs.
 * - `basePath` — optional, default `/api`. Mirrors the Hono
 *   sibling's default so the doc describes the same paths the
 *   generated REST surface serves.
 * - `idempotency` — optional, default `false`. When `true`, every
 *   mutation operation documents a **required** `Idempotency-Key`
 *   request header (the generated route fail-closes with 400 when the
 *   header is absent, so the doc marks it required, not optional).
 * - `expectedVersion` — optional, default `false`. When `true`,
 *   every mutation operation documents an optional `If-Match`
 *   request header carrying the expected stream version.
 */
export type OpenAPIOptions = {
  readonly info: OpenAPIInfo;
  readonly servers?: ReadonlyArray<OpenAPIServer>;
  readonly basePath?: string;
  readonly idempotency?: boolean;
  readonly expectedVersion?: boolean;
};

export type OpenAPIInfo = {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  readonly summary?: string;
  readonly termsOfService?: string;
  readonly contact?: {
    readonly name?: string;
    readonly url?: string;
    readonly email?: string;
  };
  readonly license?: {
    readonly name: string;
    readonly identifier?: string;
    readonly url?: string;
  };
};

export type OpenAPIServer = {
  readonly url: string;
  readonly description?: string;
  readonly variables?: Record<
    string,
    {
      readonly default: string;
      readonly enum?: ReadonlyArray<string>;
      readonly description?: string;
    }
  >;
};

export type OpenAPIPathItem = {
  readonly post?: OpenAPIOperation;
};

export type OpenAPIOperation = {
  readonly operationId: string;
  readonly summary: string;
  readonly tags: ReadonlyArray<string>;
  readonly parameters?: ReadonlyArray<OpenAPIParameter>;
  readonly requestBody?: OpenAPIRequestBody;
  readonly responses: Record<string, OpenAPIResponse>;
};

export type OpenAPIParameter = {
  readonly name: string;
  readonly in: "header" | "query" | "path" | "cookie";
  readonly required?: boolean;
  readonly description?: string;
  readonly schema?: Record<string, unknown>;
};

export type OpenAPIRequestBody = {
  readonly required?: boolean;
  readonly content: Record<
    string,
    { readonly schema: Record<string, unknown> }
  >;
};

export type OpenAPIResponse =
  | {
      readonly description: string;
      readonly content?: Record<
        string,
        { readonly schema: Record<string, unknown> }
      >;
    }
  | { readonly $ref: string };

export type OpenAPIComponents = {
  readonly schemas: Record<string, Record<string, unknown>>;
  readonly responses: Record<string, OpenAPIResponse>;
};

const DEFAULT_BASE_PATH = "/api";

/**
 * The shared `ApiError` envelope schema, ref'd by every error
 * response. Matches the runtime envelope at
 * `@rotorsoft/act-http/api`'s `toApiError` exactly — keep in sync if
 * the envelope shape evolves.
 */
const API_ERROR_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    error: { type: "string" },
    detail: { type: "string" },
    code: { type: "string" },
  },
  required: ["error"],
};

/**
 * The generic snapshot-array response schema returned on a
 * successful mutation. Each action commits one or more events; the
 * shape here is `Snapshot[]` with the per-action state and event
 * data left as open `object` (deeper per-action typing would need
 * to walk `state.events[*]` and emit a discriminated union — a
 * future refinement once the doc consumers ask for it).
 */
const SNAPSHOT_ARRAY_SCHEMA: Record<string, unknown> = {
  type: "array",
  items: {
    type: "object",
    properties: {
      state: { type: "object" },
      event: { type: "object" },
      version: { type: "integer" },
      patches: { type: "integer" },
      snaps: { type: "integer" },
      cache_hit: { type: "boolean" },
      replayed: { type: "integer" },
    },
    required: ["state", "version", "patches", "snaps", "cache_hit", "replayed"],
  },
};

/**
 * The error-response shape every operation references via
 * `$ref: "#/components/responses/ApiError"`. Single source of
 * truth — bug fixes to the envelope flow to every operation
 * automatically.
 */
const API_ERROR_RESPONSE: OpenAPIResponse = {
  description: "Error envelope per @rotorsoft/act-http/api's toApiError.",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiError" },
    },
  },
};

/**
 * Server URL refinement: OpenAPI permits `{variable}` template syntax
 * inside server URLs, so we substitute each capture with `x` before
 * parsing. The character class forbids both `{` and `}` inside the
 * template, matching OpenAPI's variable-name grammar exactly and
 * eliminating the catastrophic-backtracking surface CodeQL flagged
 * on `[^}]+`.
 *
 * @internal
 */
function is_valid_server_url(url: string): boolean {
  try {
    new URL(url.replace(/\{[^{}]+\}/g, "x"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Zod schema for the minimum required shape of {@link OpenAPIOptions}.
 * Same declarative-validation pattern the rest of the framework uses;
 * the OpenAPI surface is mostly free-form (`description`, `contact`,
 * `license` — the spec lets through anything that JSON-stringifies),
 * so only the load-bearing fields land here. Hosts overriding into
 * unusual shapes still get the rest of the doc emitted; this schema
 * only fails the construction call when `info.title` / `info.version`
 * is missing-or-empty or a `servers[].url` won't parse.
 *
 * @internal
 */
const OpenAPIOptionsSchema = z.object({
  info: z.object({
    title: z
      .string({ message: "openapi: info.title is required (non-empty string)" })
      .trim()
      .min(1, "openapi: info.title is required (non-empty string)"),
    version: z
      .string({
        message: "openapi: info.version is required (non-empty string)",
      })
      .trim()
      .min(1, "openapi: info.version is required (non-empty string)"),
  }),
  servers: z
    .array(
      z.object({
        url: z.string().refine(is_valid_server_url, {
          message: "openapi: invalid server url",
        }),
      })
    )
    .optional(),
});

function validate_options(options: OpenAPIOptions): void {
  OpenAPIOptionsSchema.parse({
    info: { title: options.info?.title, version: options.info?.version },
    servers: options.servers,
  });
}

function strip_json_schema_meta(
  schema: Record<string, unknown>
): Record<string, unknown> {
  // `$schema` at the top of an inline schema is harmless in OpenAPI
  // 3.1 but adds noise to the doc. Drop it.
  const { $schema: _, ...rest } = schema;
  return rest;
}

/**
 * Annotate the emitted request-body schema's sensitive properties so
 * codegen / Swagger UI treat them as secrets rather than echoing them
 * freely. `z.toJSONSchema` has no knowledge of the sensitive registry
 * (`sensitive()` marks schemas out-of-band in a WeakMap), so we walk the
 * action's declared sensitive fields — via `pii_fields`, the same lookup
 * the orchestrator uses — and mark each matching property `writeOnly:
 * true` + `format: password`. Non-object schemas and actions with no
 * sensitive fields pass through untouched (the zero-cost common path).
 *
 * `pii_fields` only reports top-level keys of a `z.object`, and Zod's
 * JSON Schema emit always renders those as members of `properties` — so
 * once `fields` is non-empty, `body_schema.properties[field]` is
 * guaranteed present. No defensive fallback needed.
 *
 * @internal
 */
function mark_sensitive_fields(
  body_schema: Record<string, unknown>,
  zod_schema: z.ZodType
): Record<string, unknown> {
  const fields = pii_fields(zod_schema);
  if (fields.length === 0) return body_schema;
  const properties = body_schema.properties as Record<
    string,
    Record<string, unknown>
  >;
  const next_properties: Record<string, Record<string, unknown>> = {
    ...properties,
  };
  for (const field of fields) {
    next_properties[field] = {
      ...properties[field],
      writeOnly: true,
      format: "password",
    };
  }
  return { ...body_schema, properties: next_properties };
}

function build_operation(
  action_name: string,
  body_schema: Record<string, unknown>,
  options: OpenAPIOptions
): OpenAPIOperation {
  const parameters: OpenAPIParameter[] = [];
  if (options.idempotency) {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      // Required: the generated route fail-closes with 400 when idempotency is
      // enabled and the header is absent, so the doc must not advertise it as
      // optional (#1287).
      required: true,
      description:
        "Required idempotency token. Duplicate values produce a 409 Conflict; first-claim result is not cached on the server.",
      schema: { type: "string" },
    });
  }
  if (options.expectedVersion) {
    parameters.push({
      name: "If-Match",
      in: "header",
      required: false,
      description:
        "Expected stream version for optimistic concurrency. Mismatch produces a 412 Precondition Failed via ConcurrencyError.",
      schema: { type: "string" },
    });
  }

  return {
    operationId: action_name,
    summary: `Commit the ${action_name} action`,
    tags: ["Actions"],
    ...(parameters.length > 0 ? { parameters } : {}),
    requestBody: {
      required: true,
      content: {
        "application/json": { schema: body_schema },
      },
    },
    responses: {
      "200": {
        description: "Action committed; returns the snapshot array.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/SnapshotArray" },
          },
        },
      },
      "400": { $ref: "#/components/responses/ApiError" },
      "409": { $ref: "#/components/responses/ApiError" },
      "410": { $ref: "#/components/responses/ApiError" },
      "412": { $ref: "#/components/responses/ApiError" },
      "422": { $ref: "#/components/responses/ApiError" },
      "500": { $ref: "#/components/responses/ApiError" },
    },
  };
}

/**
 * Build an OpenAPI 3.1 document describing a built `Act` instance's
 * action surface.
 *
 * Walks `app.registry.actions` once and emits a `POST
 * <basePath>/actions/<actionName>` operation per action, deriving
 * the request-body schema from each action's Zod definition via
 * `z.toJSONSchema` (Zod 4's native JSON Schema 2020-12 emitter,
 * which is the OpenAPI 3.1 schema dialect — no conversion layer
 * needed). Error responses reference the shared
 * `#/components/responses/ApiError` so a single envelope shape
 * covers every error path.
 *
 * @param app A built `Act` orchestrator. Required.
 * @param options Document-shape fields (`info.title`, `info.version`,
 *   servers, base path) and toggles for the cross-cutting headers
 *   the live REST API may accept (`Idempotency-Key`, `If-Match`).
 * @returns A valid OpenAPI 3.1 document object — serve as
 *   `/openapi.json`, ship to a CDN, write to disk during CI, or
 *   pipe to a codegen tool.
 *
 * @throws Error if `info.title` / `info.version` is missing or
 *   empty, or if any `servers[].url` fails URL parsing after
 *   `{variable}` substitution.
 */
/**
 * Structural shape of the Act surface this emitter walks. Letting
 * TApp infer to the caller's concrete `Act<TSchemaReg, ...>` instead
 * of forcing it to fit a narrow framework-typed upper bound keeps
 * the caller's variance from leaking — and avoids `any` in the
 * signature.
 *
 * @internal
 */
type ActRegistryView = {
  readonly registry: {
    actions: Record<
      string,
      {
        readonly name: string;
        readonly actions: Record<string, unknown>;
      }
    >;
  };
};

export function openapi<TApp extends ActRegistryView>(
  app: TApp,
  options: OpenAPIOptions
): OpenAPIDocument {
  validate_options(options);
  const base_path = options.basePath ?? DEFAULT_BASE_PATH;
  const paths: Record<string, OpenAPIPathItem> = {};

  for (const [action_name, state] of Object.entries(app.registry.actions)) {
    const zod_schema = state.actions[action_name] as z.ZodType;
    const body_schema = mark_sensitive_fields(
      strip_json_schema_meta(
        z.toJSONSchema(zod_schema) as Record<string, unknown>
      ),
      zod_schema
    );
    paths[`${base_path}/actions/${action_name}`] = {
      post: build_operation(action_name, body_schema, options),
    };
  }

  return {
    openapi: "3.1.0",
    info: options.info,
    ...(options.servers ? { servers: options.servers } : {}),
    paths,
    components: {
      schemas: {
        ApiError: API_ERROR_SCHEMA,
        SnapshotArray: SNAPSHOT_ARRAY_SCHEMA,
      },
      responses: {
        ApiError: API_ERROR_RESPONSE,
      },
    },
  };
}
