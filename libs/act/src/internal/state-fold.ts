/**
 * @module state-fold
 * @category Internal
 *
 * Fold engine behind `projection(name).of(state)` — maintains per-stream
 * folded states in a bounded in-memory cache and flushes one row per dirty
 * stream per round, so write amplification tracks the distinct-key count
 * instead of the event count.
 *
 * The flush payload deliberately has no type of its own: a state
 * projection flushes the cache layer outward — the rows ARE the
 * streams' {@link CacheEntry} values.
 *
 * Correctness discipline:
 * - The engine runs as the projection's batch handler, so the watermark
 *   acks only after a fully-flushed batch — fold work is never
 *   acknowledged before it is durable.
 * - On first sight of a stream the engine loads its head state through
 *   the same `load()` the command path uses (cache, snapshots and all);
 *   fetched events at or below the loaded frontier are skipped, later
 *   ones fold through the state's own patch reducers.
 * - Eviction under `maxCachedStates` pressure flushes the evictee first
 *   (flush-before-evict) — eviction never loses folded work.
 */
import { z } from "zod";
import { cache as state_cache } from "../ports.js";
import type {
  BatchHandler,
  CacheEntry,
  FoldOptions,
  Schema,
  Schemas,
  State,
} from "../types/index.js";
import { fold_state, load } from "./event-sourcing.js";

export const DEFAULT_FOLD_FLUSH_EVERY = 1_000;
export const DEFAULT_MAX_CACHED_STATES = 10_000;

const FoldOptionsSchema = z.object({
  flushEvery: z.number().int().min(1).default(DEFAULT_FOLD_FLUSH_EVERY),
  maxCachedStates: z.number().int().min(1).default(DEFAULT_MAX_CACHED_STATES),
});

export type FoldConfig = z.infer<typeof FoldOptionsSchema>;

export function resolveFoldConfig(options: FoldOptions): FoldConfig {
  return FoldOptionsSchema.parse(options);
}

/**
 * A stream's in-flight fold: a mutable {@link CacheEntry} plus the
 * engine's `dirty` flag. Mutable because the hot loop updates one
 * object per stream rather than allocating per event; the required
 * frontier fields are what keep a warm-cache load from ever
 * re-applying history. Stripping `dirty` at the flush boundary yields
 * the entry — the flush payload IS the cache entry.
 */
type Fold<TState extends Schema> = {
  -readonly [K in keyof CacheEntry<TState>]: CacheEntry<TState>[K];
} & { dirty: boolean };

/**
 * Build the batch handler that folds a state's events into per-stream rows.
 * The returned closure is long-lived (one per built projection): its cache
 * survives across drain cycles, so warm streams fold without I/O.
 */
export function make_fold_handler<
  TState extends Schema,
  TEvents extends Schemas,
  TActions extends Schemas,
>(
  me: State<TState, TEvents, TActions>,
  flush: (rows: ReadonlyArray<CacheEntry<TState>>) => Promise<void>,
  config: FoldConfig,
  validate_state = false
): BatchHandler<TEvents> {
  // Insertion-ordered Map as LRU: first key is the oldest. A promote is
  // delete + re-insert. Not the shared LruMap — eviction here must await
  // a flush, and a sync auto-evicting set() would drop folded work.
  const cache = new Map<string, Fold<TState>>();

  const row = ({ dirty: _, ...row }: Fold<TState>): CacheEntry<TState> => row;

  const flush_dirty = async () => {
    const rows: CacheEntry<TState>[] = [];
    const flushed: Fold<TState>[] = [];
    for (const f of cache.values())
      if (f.dirty) {
        rows.push(row(f));
        flushed.push(f);
      }
    if (rows.length === 0) return;
    await flush(rows);
    for (const f of flushed) f.dirty = false;
  };

  return async (events) => {
    let folded_since_flush = 0;
    for (const event of events) {
      const stream = event.stream;
      let fold = cache.get(stream);
      if (fold) {
        // promote to most-recent
        cache.delete(stream);
        cache.set(stream, fold);
      } else {
        if (cache.size >= config.maxCachedStates) {
          // flush-before-evict: the oldest entry leaves only after its
          // folded work is durable.
          const oldest = cache.keys().next().value as string;
          const evictee = cache.get(oldest) as Fold<TState>;
          if (evictee.dirty) await flush([row(evictee)]);
          cache.delete(oldest);
        }
        // First sight of this stream: load its head state through the
        // regular load path (cache, snapshots). On a warm cache hit the
        // snapshot carries no event (nothing replayed) — the frontier
        // lives in the cache entry, so read it back. Dirty from the
        // start: the row must be written at least once.
        const snapshot = await load(me, { stream }, undefined, validate_state);
        const entry = await state_cache().get<TState>(stream);
        // The engine only sees streams with committed events, so when the
        // cache has no entry (pii-aware states never cache) the load
        // replayed at least one event — snapshot.event is set.
        const frontier = entry ?? {
          version: (snapshot.event as { version: number }).version,
          event_id: (snapshot.event as { id: number }).id,
          patches: snapshot.patches,
          snaps: snapshot.snaps,
        };
        fold = {
          stream,
          state: snapshot.state,
          version: frontier.version,
          event_id: frontier.event_id,
          patches: frontier.patches,
          snaps: frontier.snaps,
          dirty: true,
        };
        cache.set(stream, fold);
      }
      if (event.id > fold.event_id) {
        const reducer = me.patch[event.name as keyof TEvents];
        fold.state = fold_state(
          me,
          fold.state,
          reducer(event as never, fold.state),
          event as never,
          validate_state
        );
        fold.version = event.version;
        fold.event_id = event.id;
        fold.patches++;
        fold.dirty = true;
      } else {
        // Already folded (head load or redelivery) — mark dirty anyway
        // so replays repopulate the read table: this is what keeps a
        // rebuild at one upsert per stream instead of zero.
        fold.dirty = true;
      }
      if (++folded_since_flush >= config.flushEvery) {
        await flush_dirty();
        folded_since_flush = 0;
      }
    }
    // Flush before returning: the drain acks this batch's watermark only
    // after the handler resolves, so rows are durable before the ack.
    await flush_dirty();
  };
}
