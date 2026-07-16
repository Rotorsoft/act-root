import { minSafeTtl, type RetryProfile } from "./min-safe-ttl.js";
import type { IdempotencyStore } from "./port.js";

/**
 * Options for {@link InMemoryIdempotencyStore}. Defaults are sized
 * for a single-process receiver paired with a sender using the
 * standard `webhook` backoff envelope (`exponential` up to
 * `maxMs: 30_000`, `maxRetries: 5`).
 *
 * The dedup window is set in one of two ways:
 *
 * - {@link ttlMs} — pass a number directly when you've already
 *   computed the window, or just want the 24-hour default that
 *   covers any reasonable sender retry envelope.
 * - {@link retryProfile} — pass the sender's retry profile and the
 *   store derives the minimum safe window for you. The math
 *   (per-retry backoff sums, per-attempt timeouts, jitter
 *   worst-case 1.5×, default 4× safety factor) is hidden inside the
 *   store — see [external integration](https://rotorsoft.github.io/act-root/docs/guides/external-integration#ttl-sizing)
 *   for the math explained.
 *
 * When both are supplied, {@link ttlMs} wins — an explicit number
 * overrides a derived one.
 */
export type InMemoryIdempotencyStoreOptions = {
  /** Direct dedup window. Default: 24 hours. */
  ttlMs?: number;
  /** Sender's retry profile — used to derive `ttlMs` when not supplied. */
  retryProfile?: RetryProfile;
  /** Memory bound — oldest entries are evicted past this size. Default: 100,000. */
  maxEntries?: number;
};

/**
 * Bounded LRU + TTL implementation of {@link IdempotencyStore} for
 * single-process receivers (the wolfdesk demo, integration tests,
 * dev loops). Multi-process receivers should swap for a durable
 * adapter (Postgres unique index, Redis `SET NX`) — the
 * {@link IdempotencyStore} contract stays the same so the call site
 * doesn't change.
 *
 * Map iteration is ordered by **last touch** — every `_record` (a fresh
 * `claim`, or a `commit` refreshing an existing key) moves the key to the
 * tail. Since each touch also stamps a fresh `expires_at` and `now` is
 * non-decreasing, iteration order tracks expiry order, so:
 * - The least-recently-touched entry sits at `keys().next().value` (the
 *   correct LRU eviction victim).
 * - GC walks until the first non-expired entry and stops.
 *
 * Keeping the key at a stale insertion position instead would let a
 * `commit`-refreshed early entry shield genuinely-expired entries from the
 * GC break-scan and make eviction drop a durable key before a staler
 * tentative one (#1268).
 *
 * Each entry carries a `committed` flag so the two-phase contract
 * holds: {@link claim} records a tentative entry (dedups concurrent
 * duplicates but is droppable), {@link commit} marks it durable, and
 * {@link release} drops it only while still tentative. GC treats
 * tentative and committed entries identically — both expire on TTL,
 * so a claim that neither committed nor released (the process died
 * mid-handler) still frees the key when the window elapses.
 *
 * `claim` is sync; durable adapters return a `Promise<boolean>` —
 * both satisfy the union return type in the port.
 */
type IdemEntry = { expires_at: number; committed: boolean };

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly _seen = new Map<string, IdemEntry>();
  private readonly _ttl_ms: number;
  private readonly _max_entries: number;

  constructor(options?: InMemoryIdempotencyStoreOptions) {
    this._ttl_ms =
      options?.ttlMs ??
      (options?.retryProfile !== undefined
        ? minSafeTtl(options.retryProfile)
        : 24 * 60 * 60 * 1000);
    this._max_entries = options?.maxEntries ?? 100_000;
  }

  claim(key: string, now: number = Date.now()): boolean {
    this._gc(now);
    if (this._seen.has(key)) return false;
    this._record(key, now, false);
    return true;
  }

  commit(key: string, now: number = Date.now()): void {
    this._record(key, now, true);
  }

  release(key: string): void {
    const entry = this._seen.get(key);
    if (entry !== undefined && !entry.committed) this._seen.delete(key);
  }

  private _record(key: string, now: number, committed: boolean): void {
    // Re-touching an existing key (a `commit` after `claim`) must move it to
    // the tail so iteration stays ordered by last touch. `Map.set` alone
    // updates the value in place but preserves the original insertion
    // position — a refreshed `expires_at` would then sit at a stale early
    // slot and break both the `_gc` break-scan and `keys().next()` eviction
    // (#1268). `delete` on an absent key is a harmless no-op.
    this._seen.delete(key);
    this._seen.set(key, { expires_at: now + this._ttl_ms, committed });
    if (this._seen.size > this._max_entries) {
      // Safe by construction: `_seen.size > _max_entries >= 0` implies at
      // least one entry, so `.next().value` resolves to a string key.
      const oldest = this._seen.keys().next().value as string;
      this._seen.delete(oldest);
    }
  }

  /** Number of entries currently tracked (post-GC at call time). */
  size(now: number = Date.now()): number {
    this._gc(now);
    return this._seen.size;
  }

  /** Drop every entry — test hook. */
  clear(): void {
    this._seen.clear();
  }

  private _gc(now: number): void {
    for (const [key, entry] of this._seen) {
      if (entry.expires_at > now) break;
      this._seen.delete(key);
    }
  }
}
