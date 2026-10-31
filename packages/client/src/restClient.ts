import type { Api } from "@act/server";
import { hc } from "hono/client";
import { SERVER_BASE } from "./trpc.js";

/**
 * The generated REST routes (`POST /api/actions/<name>`), typed from the
 * server's `Api`: each action's body and the snapshots it returns are
 * checked at compile time, as on the tRPC side.
 *
 * The server's CORS middleware permits this origin by default — see
 * `packages/server/src/server.ts`.
 */
export const rest = hc<Api>(SERVER_BASE);
