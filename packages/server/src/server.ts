import { calculatorApp } from "@act/calculator";
import { serve } from "@hono/node-server";
import { dispose } from "@rotorsoft/act";
import { openapi } from "@rotorsoft/act-http/openapi";
import { instrument } from "@rotorsoft/act-otel";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { register } from "prom-client";
import { api, router } from "./api.js";

/**
 * Multi-transport demo. One Act instance, four transports (tRPC, Hono
 * REST, OpenAPI, SSE) mounted side-by-side on a single Hono root app, which
 * makes it the integration test that the transports agree.
 * Every transport walks the same `calculatorApp` registry; the
 * OpenAPI doc describes the REST routes the Hono adapter actually
 * serves. The tRPC router and the REST routes are generated in `api.ts`,
 * and the client imports their types from this package (no codegen).
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

const apiDoc = openapi(calculatorApp, {
  info: {
    title: "Calculator API",
    version: "1.0.0",
    description:
      "Multi-transport demo for @rotorsoft/act-http — same Act registry behind tRPC, Hono REST, and this OpenAPI document.",
  },
  servers: [{ url: "http://localhost:4000" }],
});

const app = new Hono();

// Shared CORS for every transport. Hono's middleware attaches the headers
// at the response stage, so it also covers the tRPC bridge's hand-built
// `new Response(...)`.
app.use(
  "*",
  cors({
    origin: CORS_ORIGIN,
    allowHeaders: ["content-type", "idempotency-key"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  })
);

// Mount the generated REST routes.
app.route("/", api);

// Serve the OpenAPI document.
app.get("/openapi.json", (c) => c.json(apiDoc));

// Prometheus scrape endpoint — the act-otel bridge maintains the
// canonical metric set off the lifecycle events; its disposer joins
// Act's registry so shutdown tears it down with everything else.
dispose(instrument(calculatorApp));
app.get("/metrics", async (c) => c.text(await register.metrics()));

// tRPC bridge — proxy `/trpc/*` to tRPC's fetch adapter. The fetch
// adapter speaks `Request` / `Response` natively, which is exactly
// what Hono's `c.req.raw` hands us, so no Node request/response shim is
// needed.
app.all("/trpc/*", (c) =>
  fetchRequestHandler({
    endpoint: "/trpc",
    req: c.req.raw,
    router,
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
