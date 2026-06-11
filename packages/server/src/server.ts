import { calculatorApp, calculatorRouter } from "@act/calculator";
import { serve } from "@hono/node-server";
import { hono as honoTransport } from "@rotorsoft/act-http/hono";
import { openapi } from "@rotorsoft/act-http/openapi";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { Hono } from "hono";

/**
 * Multi-transport demo (#847). One Act instance, three transports
 * mounted side-by-side on a single Hono root app — the integration
 * test for the cross-transport-consistency claim made by #843
 * (tRPC), #844 (Hono REST), and #845 (OpenAPI). Every transport
 * walks the same `calculatorApp` registry; the OpenAPI doc
 * describes the REST routes the Hono adapter actually serves;
 * tRPC consumers use `typeof calculatorRouter` for their typed
 * client (no codegen).
 *
 *   POST /trpc/PressKey, /trpc/Clear   ← tRPC procedures
 *   POST /api/actions/PressKey, ...    ← REST routes
 *   GET  /openapi.json                 ← OpenAPI 3.1 document
 *   GET  /                             ← landing page with links
 *
 * Run via `pnpm dev:http` (the Vite client picks up the URL at
 * http://localhost:5173 and offers a transport toggle that
 * exercises both tRPC and REST against this same server).
 */

const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

// The generator builds the router with `initTRPC.context<{}>().create()`,
// so the standalone handler accepts the empty default context — no
// `createContext` needed.
const trpcHandler = createHTTPHandler({ router: calculatorRouter });

const restApi = honoTransport(calculatorApp, {
  actor: () => ({ id: "1", name: "Calculator" }),
  stream: () => "calculator",
  expectedVersion: () => undefined,
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

// Shared CORS for both REST and OpenAPI fetches from the Vite client.
app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", CORS_ORIGIN);
  c.header(
    "Access-Control-Allow-Headers",
    "content-type, idempotency-key, if-match"
  );
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

// Mount the generated REST routes.
app.route("/", restApi);

// Serve the OpenAPI document.
app.get("/openapi.json", (c) => c.json(apiDoc));

// tRPC bridge — proxy `/trpc/*` to the tRPC HTTP handler. tRPC's
// standalone adapter expects the `/trpc` prefix stripped; we
// rewrite before delegating, and back-port the response into a
// Hono `Response`.
app.all("/trpc/*", async (c) => {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(/^\/trpc/, "");
  const body =
    c.req.method === "POST" || c.req.method === "PUT"
      ? await c.req.text()
      : undefined;
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {};
    let status = 200;
    const chunks: Buffer[] = [];
    const responseChunks: Buffer[] = [];

    const fakeReq = {
      method: c.req.method,
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(
        Array.from(c.req.raw.headers.entries()).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ])
      ),
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === "data" && body) cb(Buffer.from(body));
        if (event === "end") cb();
      },
    } as unknown as Parameters<typeof trpcHandler>[0];

    const fakeRes = {
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value;
      },
      writeHead(s: number, h?: Record<string, string>) {
        status = s;
        if (h) Object.assign(headers, h);
      },
      write(chunk: Buffer | string) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        responseChunks.push(
          typeof chunk === "string" ? Buffer.from(chunk) : chunk
        );
      },
      end(chunk?: Buffer | string) {
        if (chunk)
          responseChunks.push(
            typeof chunk === "string" ? Buffer.from(chunk) : chunk
          );
        resolve(
          new Response(Buffer.concat(responseChunks), {
            status,
            headers,
          })
        );
      },
      on() {},
    } as unknown as Parameters<typeof trpcHandler>[1];

    Promise.resolve(trpcHandler(fakeReq, fakeRes)).catch(reject);
  });
});

// Landing page so a curious operator can poke around in a browser.
app.get("/", (c) =>
  c.html(`<!doctype html>
<html><head><title>Calculator multi-transport demo</title>
<style>body{font-family:sans-serif;max-width:720px;margin:2em auto;padding:0 1em}code{background:#f4f4f4;padding:.1em .3em;border-radius:3px}</style>
</head><body>
<h1>Calculator multi-transport demo</h1>
<p>One <code>Act</code> instance — three transports.</p>
<ul>
  <li><strong>tRPC</strong> — typed client at <a href="http://localhost:5173">http://localhost:5173</a>, procedures under <code>POST /trpc/&lt;name&gt;</code></li>
  <li><strong>Hono REST</strong> — generated REST routes under <code>POST /api/actions/&lt;name&gt;</code></li>
  <li><strong>OpenAPI</strong> — <a href="/openapi.json">/openapi.json</a> (describes the REST routes; tRPC has <code>typeof router</code> instead)</li>
</ul>
</body></html>`)
);

serve({ fetch: app.fetch, port: 4000 }, ({ port }) =>
  console.log(`Calculator multi-transport demo listening on :${port}`)
);
