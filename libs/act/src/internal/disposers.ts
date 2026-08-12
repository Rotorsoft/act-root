import type { Disposer } from "../types/index.js";

/**
 * The shape {@link register_weak_disposer} needs from a `WeakRef`. Declared
 * structurally so tests can hand in a stub that reports its target as
 * collected — real garbage collection is not schedulable, and a guarantee
 * about releasing memory deserves a deterministic test.
 */
export type RefLike<T extends object> = { deref: () => T | undefined };

/**
 * A registered cleanup function, optionally tied to the lifetime of the
 * object it cleans up. `ref` present means "run this only while its target
 * is still reachable" — the entry holds no strong reference to that target,
 * so registering never keeps it alive. The target is handed back to `run`,
 * so a weak disposer never has to re-check what the registry just proved.
 */
type Entry = {
  readonly run: (target: never) => Promise<void>;
  readonly ref?: RefLike<object>;
};

/** Registered cleanup functions, executed in reverse order during shutdown. */
const entries: Entry[] = [];

/**
 * Drop entries whose target has been collected.
 *
 * Called on every registration so the registry stays proportional to the
 * live objects rather than to every object ever built. That matters for apps
 * that mint short-lived Acts — one per tenant, per request, per test — where
 * the registry would otherwise grow without bound for the process lifetime
 * (#1441).
 */
const prune = (): void => {
  for (let i = entries.length - 1; i >= 0; i--) {
    const { ref } = entries[i];
    if (ref && !ref.deref()) entries.splice(i, 1);
  }
};

/** Register a cleanup function that runs unconditionally at teardown. */
export const register_disposer = (run: Disposer): void => {
  prune();
  entries.push({ run });
};

/**
 * Register a cleanup function bound to `ref`'s target, held weakly.
 *
 * The registry never retains the target, so an object that becomes
 * unreachable is collectable whether or not it was cleaned up first, and its
 * entry is skipped at teardown — there is nothing left to clean up.
 */
export const register_weak_disposer = <T extends object>(
  ref: RefLike<T>,
  run: (target: T) => Promise<void>
): void => {
  prune();
  entries.push({
    run: run as (target: never) => Promise<void>,
    ref: ref as RefLike<object>,
  });
};

/**
 * Run every live disposer in reverse registration order, sequentially, so a
 * disposer can rely on later-registered ones having already finished.
 *
 * Registrations are left in place, so a second teardown call re-runs them,
 * exactly as before this registry learned about weak entries.
 */
export const run_disposers = async (): Promise<void> => {
  for (const { run, ref } of [...entries].reverse()) {
    if (!ref) {
      await (run as Disposer)();
      continue;
    }
    const target = ref.deref();
    if (target) await (run as (t: object) => Promise<void>)(target);
  }
};
