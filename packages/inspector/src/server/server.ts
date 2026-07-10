import { createHTTPServer } from "@trpc/server/adapters/standalone";
import cors from "cors";
import { inspectorRouter } from "./router.js";
import { isOriginAllowed, resolveBindHost } from "./security.js";

const PORT = parseInt(process.env.PORT || "4001", 10);
// Loopback by default (#1195) — the unauthenticated inspector surface
// is not exposed to the network unless an operator opts in via
// ACT_INSPECTOR_HOST, which logs a warning.
const HOST = resolveBindHost(process.env.ACT_INSPECTOR_HOST);

const server = createHTTPServer({
  middleware: cors({
    origin: (origin, callback) => {
      callback(null, isOriginAllowed(origin, process.env.CORS_ORIGIN));
    },
  }),
  // Every HTTP request carries `viaHttp` so the router's mutation guard
  // (#1195) refuses origin-less / cross-site writes. In-process callers
  // (tests) build their own context and skip the guard.
  createContext: ({ req }) => ({
    viaHttp: true,
    origin: req.headers.origin,
    corsAllowlist: process.env.CORS_ORIGIN,
  }),
  router: inspectorRouter,
});

server.listen(PORT, HOST, () => {
  console.log(`Inspector server listening on http://${HOST}:${PORT}`);
});
