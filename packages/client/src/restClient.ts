import { SERVER_BASE } from "./trpc.js";

/**
 * Minimal REST client for the Hono adapter routes (`POST
 * /api/actions/<name>`). Matches the shape of the tRPC mutations the
 * Calculator UI consumes so the transport toggle can swap one for
 * the other behind the same `pressKey`/`clear` callback surface.
 *
 * The server's CORS middleware permits this origin (Vite at :5173)
 * by default — see `packages/server/src/server.ts`.
 */
export type Snapshot = {
  state: {
    left?: string;
    operator?: string;
    right?: string;
  };
};

export async function callRestAction(
  action: string,
  body: unknown
): Promise<Snapshot[]> {
  const res = await fetch(`${SERVER_BASE}/api/actions/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    throw new Error(detail.detail ?? detail.error ?? res.statusText);
  }
  return (await res.json()) as Snapshot[];
}
