/**
 * In-memory bounded idempotency cache. Receiver-side dedup primitive
 * for the contract documented in
 * [external integration](../../../docs/docs/guides/external-integration.md).
 *
 * Single-process only. For multi-process receivers, swap the cache for
 * Redis SETNX or a Postgres unique index — the call shape stays the same:
 * `recordIfFresh(key) => boolean`.
 */

/**
 * Bounded LRU dedup cache. Entries expire after `ttlMs`; the map is
 * also capped at `maxEntries` so a runaway sender can't blow memory.
 *
 * Map iteration is insertion-ordered, so:
 * - The oldest entry sits at `keys().next().value` (cheapest to evict).
 * - GC walks until the first non-expired entry and stops.
 */
export class IdempotencyCache {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options?: { ttlMs?: number; maxEntries?: number }) {
    this.ttlMs = options?.ttlMs ?? 24 * 60 * 60 * 1000; // 24h default
    this.maxEntries = options?.maxEntries ?? 100_000;
  }

  /**
   * Atomically record the key as seen. Returns `true` if the key was
   * fresh (and is now recorded), `false` if it was already in the
   * cache (the caller should treat the request as a duplicate).
   *
   * `now` is exposed for tests; production callers should leave it
   * undefined so wall-clock is used.
   */
  recordIfFresh(key: string, now: number = Date.now()): boolean {
    this.gc(now);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now + this.ttlMs);
    if (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  /** Number of entries currently tracked (post-GC at call time). */
  size(now: number = Date.now()): number {
    this.gc(now);
    return this.seen.size;
  }

  /** Drop every entry — test hook. */
  clear(): void {
    this.seen.clear();
  }

  private gc(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt > now) break;
      this.seen.delete(key);
    }
  }
}

/**
 * Pull the `Idempotency-Key` header from a Node-style headers bag,
 * case-insensitive. Returns `undefined` when the header is missing or
 * malformed (an array value, which would be ambiguous).
 */
export function extractIdempotencyKey(
  headers: Record<string, string | string[] | undefined>
): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "idempotency-key") continue;
    if (Array.isArray(value)) return undefined;
    return value;
  }
  return undefined;
}
