import type { ZodType } from "zod";
import {
  type ActionSelection,
  type ActSurface,
  selected_actions,
} from "./dispatch.js";

/**
 * What a transport serves over SSE: one subscription per state a generated
 * action reaches (its own state, and every state it loads, since their
 * streams change too), and those states' event names, which are the commits
 * `publish` sends. An action left out by `selection` reaches nothing, so a
 * state only it reaches is neither served nor published.
 *
 * Throws for a served state whose events declare `sensitive(...)` fields: the
 * channel caches one state per stream, folded over whichever actor committed
 * last, and serves it to every subscriber, so it would hand one actor's
 * plaintext to everyone and overwrite the owner's view with redaction
 * markers.
 */
export function sse_states(
  app: ActSurface,
  selection: ActionSelection<unknown> | undefined,
  transport: string
): { names: string[]; events: ReadonlySet<string> } {
  const states = new Map<string, Readonly<Record<string, ZodType>>>();
  for (const [, s] of selected_actions(app, selection, transport)) {
    states.set(s.name, s.events ?? {});
    for (const loads of Object.values(s.loads ?? {}))
      for (const { state } of loads ?? []) states.set(state.name, state.events);
  }
  const events = new Set<string>();
  for (const [name, of_state] of states) {
    const sensitive = Object.keys(of_state).filter(
      (event) => app.registry.sensitive_fields(event).length > 0
    );
    if (sensitive.length)
      throw new Error(
        `${transport}: state "${name}" can't be served over SSE: its events ${sensitive.map((e) => `"${e}"`).join(", ")} declare sensitive fields, and the broadcast would send one actor's view of them to every subscriber. Leave its actions out with \`actions\`, generate the API without \`sse\`, or move the sensitive fields to a state that isn't broadcast.`
      );
    for (const event of Object.keys(of_state)) events.add(event);
  }
  return { names: [...states.keys()], events };
}
