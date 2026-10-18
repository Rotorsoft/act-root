import { test } from "vitest";
import type { Act } from "../act.js";
import { InMemoryCache } from "../adapters/in-memory-cache.js";
import { InMemoryStore } from "../adapters/in-memory-store.js";
import type { ActOptions, Cache, Store } from "../types/index.js";
import type { Sandbox, SandboxOptions } from "../types/sandbox.js";

/**
 * Minimal structural shape — anything with a `.build()` that returns an
 * Act. Avoids the variance pitfalls of constraining on the full
 * `ActBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor>`
 * generic when called across package boundaries.
 */
type AnyActBuilder<TApp> = {
  // `ActOptions<any>` rather than `ActOptions<string>` (the default) — a
  // builder narrowed to `ActOptions<"default">` would otherwise trip
  // function-parameter contravariance against `ActOptions<string>`. The
  // `any` only widens `onlyLanes`; the rest of the option shape
  // (`scoped`, `correlator`, `settleDebounceMs`, etc.) still type-checks
  // at the runtime call site below.
  build: (options?: ActOptions<any>) => TApp;
};

/**
 * Build a scoped Act bound to a fresh `{ store, cache }` bag.
 *
 * Intended for parallel-safe test isolation. Each call constructs new
 * ports (defaults to InMemoryStore + InMemoryCache), seeds the store,
 * builds the Act with `ActOptions.scoped`, and returns `{ app, store,
 * cache, dispose }`. The caller owns the lifecycle: `dispose()` performs
 * `app.shutdown()` followed by `store.dispose()` + `cache.dispose()`.
 *
 * Prefer {@link fixture} when fixture-style ergonomics fit; reach for
 * `sandbox` when you need explicit control (e.g., wiring inside
 * `beforeAll` rather than per-test, or two scoped Acts in one test, or
 * direct access to the store/cache handles).
 *
 * @example Per-test isolated Act with explicit dispose
 * ```ts
 * import { sandbox } from "@rotorsoft/act/test";
 *
 * const counterBuilder = act().withState(Counter);
 *
 * it("increments", async () => {
 *   const { app, dispose } = await sandbox(counterBuilder);
 *   await app.do("increment", { stream: "c-1", actor }, { by: 1 });
 *   expect((await app.load("Counter", "c-1")).state.count).toBe(1);
 *   await dispose();
 * });
 * ```
 */
export async function sandbox<TApp>(
  builder: AnyActBuilder<TApp>,
  options: SandboxOptions = {}
): Promise<Sandbox<TApp>> {
  const store = options.store ? await options.store() : new InMemoryStore();
  const cache = options.cache ? await options.cache() : new InMemoryCache();
  await store.seed();

  const app = builder.build({
    ...options.actOptions,
    scoped: { store, cache },
  });

  let _disposed: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (!_disposed) {
      _disposed = (async () => {
        await (app as unknown as Act<any, any, any, any, any>).shutdown();
        await store.dispose();
        await cache.dispose();
      })();
    }
    return _disposed;
  };

  return { app, store, cache, dispose };
}

/**
 * Vitest fixture wrapper around {@link sandbox}.
 *
 * Returns a `test` instance with an `app` fixture — each test gets a
 * fresh, isolated Act and vitest's fixture lifecycle runs the cleanup
 * automatically when the test completes.
 *
 * Works with `test.concurrent(...)` — every concurrent invocation
 * receives its own bag, so tests don't race on the singleton.
 *
 * For tests that also need direct access to the underlying `store` /
 * `cache` handles, use {@link sandbox} explicitly.
 *
 * @example Fixture-style — auto cleanup, parallel-safe
 * ```ts
 * import { fixture } from "@rotorsoft/act/test";
 *
 * const test = fixture(act().withState(Counter));
 *
 * test("increments", async ({ app }) => {
 *   await app.do("increment", { stream: "c-1", actor }, { by: 1 });
 *   expect((await app.load("Counter", "c-1")).state.count).toBe(1);
 * });
 *
 * test.concurrent("isolated from concurrent peers", async ({ app }) => {
 *   // Each concurrent invocation gets its own store + cache — no
 *   // singleton contention, no flake.
 * });
 * ```
 */
export function fixture<TApp>(
  builder: AnyActBuilder<TApp>,
  defaults: SandboxOptions = {}
) {
  return test.extend<{ app: TApp }>({
    app: async (
      // biome-ignore lint/correctness/noEmptyPattern: vitest fixture API requires a destructured deps parameter
      {},
      use: (value: TApp) => Promise<void>
    ) => {
      const ctx = await sandbox(builder, defaults);
      try {
        await use(ctx.app);
      } finally {
        await ctx.dispose();
      }
    },
  });
}
