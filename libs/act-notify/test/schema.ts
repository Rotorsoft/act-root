/**
 * Postgres schema names, namespaced to the checkout the suite is running
 * from (#1589).
 *
 * Mirrors `libs/act-pg/test/schema.ts` — six lines rather than a cross-package
 * deep import into another package's test directory.
 *
 * Every worktree of this repo points at the same docker Postgres on 5431,
 * and every adapter suite `drop()`s and `seed()`s its schema in `beforeAll`.
 * Without a per-checkout suffix, two worktrees running these tests
 * concurrently delete each other's tables mid-run — which does not merely
 * make results flaky, it makes them meaningless, because a red says nothing
 * about the code under test.
 *
 * The suffix comes from `ACT_TEST_SCHEMA_SUFFIX`, set once in the root
 * `vite.config.ts` from that config's own directory. Stable across runs of
 * one checkout, necessarily different between worktrees.
 *
 * The `"local"` fallback covers a suite run through some other config; it
 * collides exactly as before, which is no worse than the status quo and
 * keeps a stray invocation working rather than silently pointing at a
 * schema named `undefined`.
 */
export const schema = (name: string): string =>
  `${name}_${process.env.ACT_TEST_SCHEMA_SUFFIX ?? "local"}`;
