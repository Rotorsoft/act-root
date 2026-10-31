import type { CalculatorRest } from "@act/calculator";
import { hc, type InferResponseType } from "hono/client";
import { SERVER_BASE } from "./trpc.js";

/**
 * Typed client for the generated REST routes (`POST /api/actions/<name>`),
 * from the same app the server mounts: each action's body and the
 * snapshots it returns are checked at compile time, as on the tRPC side.
 *
 * The server's CORS middleware permits this origin (Vite at :5173)
 * by default — see `packages/server/src/server.ts`.
 */
const rest = hc<CalculatorRest>(SERVER_BASE);

/** The calculator's state, as the generated API returns it. */
export type CalculatorState = InferResponseType<
  typeof rest.api.actions.PressKey.$post,
  200
>[number]["state"];

type ActionResponse =
  | Awaited<ReturnType<typeof rest.api.actions.PressKey.$post>>
  | Awaited<ReturnType<typeof rest.api.actions.Clear.$post>>;

/** The snapshots on success; the `ApiError` detail as an `Error` otherwise. */
async function snapshots(res: ActionResponse) {
  if (res.ok) return res.json();
  const error = await res.json();
  throw new Error(error.detail ?? error.error);
}

export const restPressKey = async (
  key: Parameters<typeof rest.api.actions.PressKey.$post>[0]["json"]["key"]
) => snapshots(await rest.api.actions.PressKey.$post({ json: { key } }));

export const restClear = async () =>
  snapshots(await rest.api.actions.Clear.$post({ json: {} }));
