import { pii_fields } from "@rotorsoft/act";
import type { ZodType } from "zod";
import type { ActSurface } from "./dispatch.js";

/**
 * The state names a transport opens one SSE subscription for: every state
 * in the registry. Throws for a state whose events declare `sensitive(...)`
 * fields: the channel caches one state per stream, folded over whichever
 * actor committed last, and serves it to every subscriber, so it would hand
 * one actor's plaintext to everyone and overwrite the owner's view with
 * redaction markers.
 */
export function sse_state_names(app: ActSurface, transport: string): string[] {
  const names = new Map<string, Readonly<Record<string, ZodType>>>();
  for (const s of Object.values(app.registry.actions))
    names.set(s.name, s.events ?? {});
  for (const [name, events] of names) {
    const sensitive = Object.entries(events).filter(
      ([, schema]) => pii_fields(schema).length > 0
    );
    if (sensitive.length)
      throw new Error(
        `${transport}: state "${name}" can't be served over SSE: its events ${sensitive.map(([e]) => `"${e}"`).join(", ")} declare sensitive fields, and the broadcast would send one actor's view of them to every subscriber. Generate the API without \`sse\`, or move the sensitive fields to a state that isn't broadcast.`
      );
  }
  return [...names.keys()];
}
