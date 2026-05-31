import type { IdempotencyStore } from "./port.js";

/**
 * Options for {@link InMemoryIdempotencyStore}. Both defaults are sized
 * for a single-process receiver paired with a sender using the
 * standard `webhook` backoff envelope (`exponential` up to `maxMs: 30_000`,
 * `maxRetries: 5`); larger envelopes should bump `ttlMs` accordingly
 * (see `computeMinSafeTtl` once #747 ships).
 */
export type InMemoryIdempotencyStoreOptions = {
  /** Dedup window. Default: 24 hours. */
  ttlMs?: number;
  /** Memory bound — oldest entries are evicted past this size. Default: 100,000. */
  maxEntries?: number;
};

/**
 * Bounded LRU + TTL implementation of {@link IdempotencyStore} for
 * single-process receivers (the wolfdesk demo, integration tests, dev
 * loops). Multi-process receivers should swap for a durable adapter
 * (Postgres unique index, Redis `SET NX`) — the {@link IdempotencyStore}
 * contract stays the same so the call site doesn't change.
 *
 * Map iteration is insertion-ordered, so:
 * - The oldest entry sits at `keys().next().value` (cheapest to evict).
 * - GC walks until the first non-expired entry and stops.
 *
 * `claim` is sync; durable adapters return a `Promise<boolean>` —
 * both satisfy the union return type in the port.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly _seen = new Map<string, number>();
  private readonly _ttl_ms: number;
  private readonly _max_entries: number;

  constructor(options?: InMemoryIdempotencyStoreOptions) {
    this._ttl_ms = options?.ttlMs ?? 24 * 60 * 60 * 1000;
    this._max_entries = options?.maxEntries ?? 100_000;
  }

  claim(key: string, now: number = Date.now()): boolean {
    this._gc(now);
    if (this._seen.has(key)) return false;
    this._seen.set(key, now + this._ttl_ms);
    if (this._seen.size > this._max_entries) {
      // Safe by construction: `_seen.size > _max_entries >= 0` implies at
      // least one entry, so `.next().value` resolves to a string key.
      const oldest = this._seen.keys().next().value as string;
      this._seen.delete(oldest);
    }
    return true;
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
    for (const [key, expiresAt] of this._seen) {
      if (expiresAt > now) break;
      this._seen.delete(key);
    }
  }
}
