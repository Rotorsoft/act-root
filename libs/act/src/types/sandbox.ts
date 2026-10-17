/**
 * Public contracts of the test helpers. Published only through
 * `@rotorsoft/act/test`; `types/index.ts` does not re-export them.
 */
import type { ActOptions } from "./act.js";
import type { Cache, Store } from "./ports.js";

/**
 * Options for {@link sandbox} / {@link fixture}.
 *
 * Defaults to `new InMemoryStore() + new InMemoryCache()` per call.
 * Override `store` / `cache` to point at PG, SQLite, or any other
 * adapter — factories run once per call so each test gets a fresh
 * instance.
 */
export type SandboxOptions = {
  /** Factory for the per-test store. Defaults to `new InMemoryStore()`. */
  readonly store?: () => Store | Promise<Store>;
  /** Factory for the per-test cache. Defaults to `new InMemoryCache()`. */
  readonly cache?: () => Cache | Promise<Cache>;
  /** Pass-through ActOptions. `scoped` is filled in by the helper. */
  readonly actOptions?: Omit<ActOptions, "scoped">;
};

/** Return shape of {@link sandbox}. */
export type Sandbox<TApp> = {
  readonly app: TApp;
  readonly store: Store;
  readonly cache: Cache;
  /** Tears down the Act, store, and cache. Idempotent. */
  readonly dispose: () => Promise<void>;
};
