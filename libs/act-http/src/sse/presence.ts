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
 * presence.add(game_id, player_id);
 *
 * // On SSE disconnect:
 * presence.remove(game_id, player_id);
 *
 * // Query:
 * presence.get_online(game_id); // Set<string>
 * ```
 */
export class PresenceTracker {
  private streams = new Map<string, Map<string, number>>();

  /** Increment ref count for an identity on a stream. */
  add(stream_id: string, identity_id: string): void {
    if (!this.streams.has(stream_id)) this.streams.set(stream_id, new Map());
    const counts = this.streams.get(stream_id)!;
    counts.set(identity_id, (counts.get(identity_id) ?? 0) + 1);
  }

  /** Decrement ref count. Removes the identity when count reaches 0. */
  remove(stream_id: string, identity_id: string): void {
    const counts = this.streams.get(stream_id);
    if (!counts) return;
    const n = (counts.get(identity_id) ?? 1) - 1;
    if (n <= 0) counts.delete(identity_id);
    else counts.set(identity_id, n);
    if (counts.size === 0) this.streams.delete(stream_id);
  }

  /** Get the set of online identity IDs for a stream. */
  get_online(stream_id: string): Set<string> {
    const counts = this.streams.get(stream_id);
    return counts ? new Set(counts.keys()) : new Set();
  }

  /** Check if a specific identity is online for a stream. */
  is_online(stream_id: string, identity_id: string): boolean {
    return (this.streams.get(stream_id)?.get(identity_id) ?? 0) > 0;
  }
}
