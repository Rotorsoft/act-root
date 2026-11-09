import { InMemoryStore, type Lease, type Store } from "@rotorsoft/act";
import { fixture } from "@rotorsoft/act/test";
import { rules } from "./index.js";

let store: Store;
export const test = fixture(rules, {
  store: () => (store = new InMemoryStore()),
});

const actor = { id: "a", name: "a" };
export const at = (stream: string) => ({ stream, actor });

/** The names of the events stored on a stream. */
export const events = async (stream: string) => {
  const names: string[] = [];
  await store.query((e) => names.push(e.name as string), {
    stream,
    stream_exact: true,
  });
  return names;
};

/** Resolves once a drain acks `stream`; a deferred reaction's wait isn't an ack. */
type OnAcked = {
  on(event: "acked", listener: (leases: Lease[]) => void): unknown;
};
export const acked = (app: OnAcked, stream: string) =>
  new Promise<void>((resolve) =>
    app.on("acked", (leases: Lease[]) => {
      if (leases.some((l) => l.stream === stream)) resolve();
    })
  );

/** Every stored row, as the store holds it. */
export const rows = async () => {
  const found: unknown[] = [];
  await store.query((e) => found.push(e));
  return JSON.stringify(found);
};

/** Runs `rival` right before the next commit, as if it won a race. */
export const rival_before_commit = (rival: () => Promise<unknown>) => {
  const commit = store.commit.bind(store);
  vi.spyOn(store, "commit").mockImplementationOnce(async (...args) => {
    await rival();
    return commit(...args);
  });
};
