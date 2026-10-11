import type { Store } from "@rotorsoft/act/types";

/**
 * Correlate's job, done by hand. `claim` follows the work mark, so a
 * generated plan that commits events has to mark what they resolve to before
 * a worker can see them. Marking every subscription to the log head is the
 * right shape for the property and differential suites: they drive adapters
 * through the *same* plan, and what they compare is claim/ack/block/defer
 * behavior, not discovery. Not exported from the package.
 */
export const mark_all = async (store: Store) => {
  const rows: {
    stream: string;
    at: number;
    priority: number;
    lane?: string;
  }[] = [];
  const { maxEventId } = await store.query_streams((p) =>
    rows.push({
      stream: p.stream,
      at: p.at,
      priority: p.priority,
      lane: p.lane,
    })
  );
  const marks = rows
    .filter((r) => r.at < maxEventId)
    .map((r) => ({
      stream: r.stream,
      priority: r.priority,
      lane: r.lane,
      correlated_at: maxEventId,
    }));
  // Unconditional: `subscribe([])` is a no-op, and a guard here would be a
  // branch no generated plan exercises.
  await store.subscribe(marks);
};
