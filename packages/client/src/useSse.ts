import {
  applyPatchMessage,
  type BroadcastState,
  type PatchMessage,
} from "@rotorsoft/act-http/sse";
import { useEffect, useRef, useState } from "react";

/**
 * Minimal EventSource hook for the generated SSE endpoints at
 * `GET /api/sse/<stateName>?stream=<streamId>` (mounted by
 * `hono(app, { sse })` — see `packages/server/src/server.ts`).
 *
 * Wire protocol (per `@rotorsoft/act-http/hono`):
 * - `event: state` — full cached state, sent on (re)connect when the
 *   server has one for the stream. Replaces the local copy.
 * - `event: patch` — version-keyed domain patches, applied with
 *   `applyPatchMessage`. A `behind` result (missed versions, or no
 *   local state yet) reconnects so the server re-seeds the full
 *   cached state.
 * - `event: ping` — heartbeat, ignored.
 */
export function useSse<S extends BroadcastState>(url: string): S | undefined {
  const [state, setState] = useState<S>();
  const [generation, setGeneration] = useState(0);
  const cached = useRef<S | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` is a deliberate extra dependency — bumping it tears down and reopens the EventSource so the server re-seeds the full cached state after a "behind" resync
  useEffect(() => {
    const es = new EventSource(url);
    const resync = () => {
      // Reopen the stream — the server yields its cached full state
      // as an `event: state` frame on every (re)connect.
      es.close();
      setGeneration((g) => g + 1);
    };
    es.addEventListener("state", (e) => {
      cached.current = JSON.parse((e as MessageEvent).data) as S;
      setState(cached.current);
    });
    es.addEventListener("patch", (e) => {
      const msg = JSON.parse((e as MessageEvent).data) as PatchMessage<S>;
      const result = applyPatchMessage(msg, cached.current);
      if (result.ok) {
        cached.current = result.state;
        setState(result.state);
      } else if (result.reason === "behind" || !cached.current) {
        resync();
      }
      // "stale" with local state → no-op, we're already ahead (the
      // mutation response can land before its own SSE patch does).
    });
    return () => es.close();
  }, [url, generation]);

  return state;
}
