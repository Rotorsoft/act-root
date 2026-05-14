import { randomUUID } from "node:crypto";
import type {
  Committed,
  EventMeta,
  Message,
  Store,
} from "@rotorsoft/act/types";
import type { CounterEvents } from "./events.js";

export type CounterMessage = Message<CounterEvents, keyof CounterEvents>;
export type CommittedCounterEvent = Committed<
  CounterEvents,
  keyof CounterEvents
>;

/**
 * Per-test unique identifier suffix. Use to namespace streams so tests
 * running in parallel against the same shared store (e.g., a real Postgres
 * instance) don't collide on stream names.
 */
export const uid = (): string => randomUUID().slice(0, 8);

export const actor = (name = "tester") => ({ id: randomUUID(), name });

/** Build an EventMeta with a correlation id and optional action causation. */
export const makeMeta = (
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

export const inc = (amount = 1): CounterMessage => ({
  name: "Incremented",
  data: { amount },
});

export const dec = (amount = 1): CounterMessage => ({
  name: "Decremented",
  data: { amount },
});

export const reset = (): CounterMessage => ({ name: "Reset", data: {} });

/**
 * Commit `count` Incremented events to `stream` on the given store, each
 * within its own commit transaction (so they receive distinct event ids).
 */
export const seedStream = async (
  store: Store,
  stream: string,
  count: number,
  correlation?: string
): Promise<CommittedCounterEvent[]> => {
  const out: CommittedCounterEvent[] = [];
  for (let i = 0; i < count; i++) {
    const committed = await store.commit<CounterEvents>(
      stream,
      [inc(1)],
      makeMeta({ correlation, stream })
    );
    out.push(...(committed as CommittedCounterEvent[]));
  }
  return out;
};

/**
 * Drain a `query` call into an array. Convenience wrapper for assertions.
 */
export const collect = async (
  store: Store,
  query: Parameters<Store["query"]>[1]
): Promise<CommittedCounterEvent[]> => {
  const out: CommittedCounterEvent[] = [];
  await store.query<CounterEvents>((e) => {
    out.push(e as CommittedCounterEvent);
  }, query);
  return out;
};
