import {
  calculatorApp,
  calculatorRouter,
  type Operators,
} from "@act/calculator";
import { serve } from "@hono/node-server";
import { dispose } from "@rotorsoft/act";
import { hono as honoTransport } from "@rotorsoft/act-http/hono";
import { openapi } from "@rotorsoft/act-http/openapi";
import { BroadcastChannel } from "@rotorsoft/act-http/sse";
import { instrument } from "@rotorsoft/act-otel";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { register } from "prom-client";

/**
 * Multi-transport demo (#847, #1123). One Act instance, four
 * transports mounted side-by-side on a single Hono root app — the
 * integration test for the cross-transport-consistency claim made
 * by #843 (tRPC), #844 (Hono REST), #845 (OpenAPI), and #846 (SSE).
 * Every transport walks the same `calculatorApp` registry; the
 * OpenAPI doc describes the REST routes the Hono adapter actually
 * serves; tRPC consumers use `typeof calculatorRouter` for their
 * typed client (no codegen).
 *
 *   POST /trpc/PressKey, /trpc/Clear   ← tRPC procedures
 *   POST /api/actions/PressKey, ...    ← REST routes
 *   GET  /api/sse/Calculator?stream=…  ← SSE live-state stream
 *   GET  /openapi.json                 ← OpenAPI 3.1 document
 *   GET  /                             ← landing page with links
 *
 * Run via `pnpm dev:http` (the Vite client picks up the URL at
 * http://localhost:5173 and offers a transport toggle that
 * exercises both tRPC and REST against this same server).
 */

const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

/**
 * The broadcast view of the calculator: the domain state plus the
 * `_v` version contract (`_v` is always `snap.event.version` — the
 * event store's stream version is the single source of truth).
 */
type CalculatorLiveState = {
  _v: number;
  left?: string;
  right?: string;
  operator?: Operators;
  result: number;
};

// SSE broadcast (#1123). One in-memory channel shared with the
// generated Hono surface below, which mounts one streaming
// `GET /api/sse/<stateName>?stream=<streamId>` per registered state.
// Publication is host-owned: every local commit — tRPC bridge and
// REST alike, both funnel through `calculatorApp.do` — lands here
// via the `committed` lifecycle event and fans out to subscribers
// as version-keyed domain patches.
const broadcast = new BroadcastChannel<CalculatorLiveState>();
calculatorApp.on("committed", (snapshots) => {
  // The lifecycle payload is loosely typed by design — commits from any
  // registered state land here. This app registers a single state, so
  // narrow to its shape once.
  const snaps = snapshots as unknown as {
    state: Omit<CalculatorLiveState, "_v">;
    event?: { stream: string; version: number };
    patch?: Partial<CalculatorLiveState>;
  }[];
  const last = snaps.at(-1);
  if (!last?.event) return;
  broadcast.publish(
    last.event.stream,
    { ...last.state, _v: last.event.version },
    snaps
      .map((s) => s.patch)
      .filter((p): p is Partial<CalculatorLiveState> => p !== undefined)
  );
});

const restApi = honoTransport(calculatorApp, {
  actor: () => ({ id: "1", name: "Calculator" }),
  stream: () => "calculator",
  expectedVersion: () => undefined,
  sse: { channel: broadcast },
});

const apiDoc = openapi(calculatorApp, {
  info: {
    title: "Calculator API",
    version: "1.0.0",
    description:
      "Multi-transport demo for @rotorsoft/act-http — same Act registry behind tRPC, Hono REST, and this OpenAPI document.",
  },
  servers: [{ url: "http://localhost:4000" }],
  expectedVersion: true,
});

const app = new Hono();

// Shared CORS for every transport. Hono's built-in middleware attaches
// the headers at the response stage, so it covers both `c.json(...)`
// returns (REST + openapi) and the tRPC bridge's hand-built
// `new Response(...)` — the previous `c.header(...)` form set the
// header on the context only, which the fresh Response from the bridge
// discarded, breaking tRPC's preflight check.
app.use(
  "*",
  cors({
    origin: CORS_ORIGIN,
    allowHeaders: ["content-type", "idempotency-key", "if-match"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  })
);

// Mount the generated REST routes.
app.route("/", restApi);

// Serve the OpenAPI document.
app.get("/openapi.json", (c) => c.json(apiDoc));

// Prometheus scrape endpoint — the act-otel bridge maintains the
// canonical metric set off the lifecycle events; its disposer joins
// Act's registry so shutdown tears it down with everything else.
dispose(instrument(calculatorApp));
app.get("/metrics", async (c) => c.text(await register.metrics()));

// tRPC bridge — proxy `/trpc/*` to tRPC's fetch adapter. The fetch
// adapter speaks `Request` / `Response` natively, which is exactly
// what Hono's `c.req.raw` hands us — no Node `IncomingMessage` /
// `ServerResponse` shim needed (the previous standalone-adapter
// shim missed `.once()` and broke at runtime).
app.all("/trpc/*", (c) =>
  fetchRequestHandler({
    endpoint: "/trpc",
    req: c.req.raw,
    router: calculatorRouter,
  })
);

// Interactive API docs at /docs — Scalar API Reference renders the
// OpenAPI document into a clean three-pane explorer with a built-in
// "Try It" client. CDN-hosted (no build step), reads from the live
// `/openapi.json` so changes to the registry surface immediately.
app.get("/docs", (c) =>
  c.html(`<!doctype html>
<html>
<head>
  <title>Calculator API — interactive docs</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <script id="api-reference" data-url="/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`)
);

// Landing page so a curious operator can poke around in a browser.
app.get("/", (c) =>
  c.html(`<!doctype html>
<html><head><title>Calculator multi-transport demo</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:760px;margin:2em auto;padding:0 1em;color:#1a1a1a;line-height:1.55}
  h1{font-weight:600}
  code{background:#f4f4f4;padding:.1em .3em;border-radius:3px;font-size:0.92em}
  ul{padding-left:1.2em}
  li{margin:.6em 0}
  a{color:#0366d6;text-decoration:none}
  a:hover{text-decoration:underline}
  .label{display:inline-block;min-width:8em;font-weight:600}
</style>
</head><body>
<h1>Calculator multi-transport demo</h1>
<p>One <code>Act</code> instance — four transports walking the same registry.</p>
<ul>
  <li><span class="label">tRPC client</span> <a href="http://localhost:3000">http://localhost:3000</a> — typed React UI with a transport toggle</li>
  <li><span class="label">tRPC procedures</span> <code>POST /trpc/PressKey</code>, <code>POST /trpc/Clear</code></li>
  <li><span class="label">Hono REST</span> <code>POST /api/actions/PressKey</code>, <code>POST /api/actions/Clear</code></li>
  <li><span class="label">SSE stream</span> <code>GET /api/sse/Calculator?stream=calculator</code> — live state patches over <code>text/event-stream</code></li>
  <li><span class="label">API docs</span> <a href="/docs">/docs</a> — interactive Scalar reference (try it from the browser)</li>
  <li><span class="label">OpenAPI spec</span> <a href="/openapi.json">/openapi.json</a> — raw JSON describing the REST routes</li>
</ul>
</body></html>`)
);

serve({ fetch: app.fetch, port: 4000 }, ({ port }) =>
  console.log(`Calculator multi-transport demo listening on :${port}`)
);
