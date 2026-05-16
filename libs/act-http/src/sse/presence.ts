/**
 * Generic presence tracker — ref-counted online status per stream per identity.
 *
 * Supports multi-tab: each subscribe increments the ref count, each
 * unsubscribe decrements it. An identity is considered online when
 * ref count > 0.
 *
 * ## Usage
 *
 * ```typescript
 * const presence = new PresenceTracker();
 *
 * // On SSE connect:
 * presence.add(gameId, playerId);
 *
 * // On SSE disconnect:
 * presence.remove(gameId, playerId);
 *
 * // Query:
 * presence.getOnline(gameId); // Set<string>
 * ```
 */
export class PresenceTracker {
  private streams = new Map<string, Map<string, number>>();

  /** Increment ref count for an identity on a stream. */
  add(streamId: string, identityId: string): void {
    if (!this.streams.has(streamId)) this.streams.set(streamId, new Map());
    const counts = this.streams.get(streamId)!;
    counts.set(identityId, (counts.get(identityId) ?? 0) + 1);
  }

  /** Decrement ref count. Removes the identity when count reaches 0. */
  remove(streamId: string, identityId: string): void {
    const counts = this.streams.get(streamId);
    if (!counts) return;
    const n = (counts.get(identityId) ?? 1) - 1;
    if (n <= 0) counts.delete(identityId);
    else counts.set(identityId, n);
    if (counts.size === 0) this.streams.delete(streamId);
  }

  /** Get the set of online identity IDs for a stream. */
  getOnline(streamId: string): Set<string> {
    const counts = this.streams.get(streamId);
    return counts ? new Set(counts.keys()) : new Set();
  }

  /** Check if a specific identity is online for a stream. */
  isOnline(streamId: string, identityId: string): boolean {
    return (this.streams.get(streamId)?.get(identityId) ?? 0) > 0;
  }
}
