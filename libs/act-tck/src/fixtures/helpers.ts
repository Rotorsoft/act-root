import { randomUUID } from "node:crypto";
import type { Committed, Message, Store } from "@rotorsoft/act/types";
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
