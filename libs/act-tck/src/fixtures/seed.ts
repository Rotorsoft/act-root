// Seeders the TCKs share; not re-exported from the package root.
import { randomUUID } from "node:crypto";
import type { EventMeta, Store } from "@rotorsoft/act";
import type { CounterEvents } from "./events.js";
import { actor, type CommittedCounterEvent, inc } from "./helpers.js";

/** Build an EventMeta with a correlation id and optional action causation. */
export const make_meta = (
  opts: { correlation?: string; stream?: string; action?: string } = {}
): EventMeta => ({
  correlation: opts.correlation ?? randomUUID(),
  causation: opts.stream
    ? {
        action: {
          name: opts.action ?? "Test",
          stream: opts.stream,
          actor: actor(),
        },
      }
    : {},
});

/**
 * Commit `count` Incremented events to `stream` on the given store, each
 * within its own commit transaction (so they receive distinct event ids).
 */
export const seed_stream = async (
  store: Store,
  stream: string,
  count: number,
  correlation?: string
): Promise<CommittedCounterEvent[]> => {
  const out: CommittedCounterEvent[] = [];
  for (let i = 0; i < count; i++) {
    const committed = await store.commit<CounterEvents>(
      [{ stream, msgs: [inc(1)] }],
      make_meta({ correlation, stream })
    );
    out.push(...(committed as CommittedCounterEvent[]));
  }
  return out;
};
