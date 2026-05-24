/**
 * Shared test helpers for the inspector test suite (ACT-1131).
 *
 * Each spec file declares its own `vi.mock("@rotorsoft/act-pg", …)` and
 * `vi.hoisted(() => …)` block — both must be hoisted to the top of the
 * file by Vitest, which means they can't live here. What lives here is
 * the post-connect plumbing: a stub `EventMeta`, seed helpers that
 * commit events through `Store.commit`, and a typed `RouterCaller` so
 * specs don't repeat `inspectorRouter.createCaller({})` boilerplate.
 */
import type { EventMeta, Store } from "@rotorsoft/act";
import type { inspectorRouter } from "../src/server/router.js";

export type RouterCaller = ReturnType<typeof inspectorRouter.createCaller>;

/** Minimal stub meta — every committed event needs a correlation + causation pair. */
export const stubMeta: EventMeta = {
  correlation: "test-correlation",
  causation: {},
};

/**
 * Seed a single event onto a stream. Returns the committed event so
 * callers can read back the assigned `id` / `version` / `created`.
 *
 * `expectedVersion` defaults to `undefined` — the underlying store
 * accepts the next version naturally. Pass an explicit value when the
 * test asserts on concurrency behavior.
 */
export async function seed(
  store: Store,
  stream: string,
  name: string,
  data: Record<string, unknown> = {},
  expectedVersion?: number
) {
  const committed = await store.commit(
    stream,
    [{ name, data }],
    stubMeta,
    expectedVersion
  );
  return committed[0]!;
}

/** Seed a sequence of events on the same stream, advancing version automatically. */
export async function seedSequence(
  store: Store,
  stream: string,
  events: Array<{ name: string; data?: Record<string, unknown> }>
) {
  const committed: Array<Awaited<ReturnType<typeof seed>>> = [];
  // Optimistic-concurrency expected value: -1 before the first commit,
  // then `i - 1` thereafter as the store's recorded version climbs. The
  // store's check fires only when `expectedVersion` is a number, but we
  // pass the right value anyway so tests that flip on concurrency
  // detection (#785 / #786) inherit a fixture that already matches.
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    committed.push(await seed(store, stream, e.name, e.data ?? {}, i - 1));
  }
  return committed;
}

/**
 * Default `connect` input — every field has a Zod default in the
 * router, so passing `{}` works, but specs sometimes need to override
 * `schema` or `table` for assertion clarity. Tests spread this object
 * and override what they care about.
 */
export const defaultConnectInput = {
  host: "localhost",
  port: 5432,
  database: "test",
  user: "test",
  password: "test",
  schema: "public",
  table: "events",
  ssl: false,
};
