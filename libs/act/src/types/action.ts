import type { Patch } from "@rotorsoft/act-patch";
import type { ZodType, z } from "zod";
import type { Disposable, TruncateResult } from "./ports.js";
import type {
  ActorSchema,
  CausationEventSchema,
  CommittedMetaSchema,
  EventMetaSchema,
  QuerySchema,
} from "./schemas.js";

/**
 * @packageDocumentation
 * @module act/types
 * @category Types
 * Types for actions, events, schemas, and state in the Act Framework.
 */

/**
 * Represents an actor (user or system) performing an action.
 *
 * Actors provide audit trail and authorization context. Every action
 * must specify who is performing it for accountability and access control.
 *
 * @example User actor
 * ```typescript
 * const actor: Actor = {
 *   id: "user-123",
 *   name: "Alice Smith"
 * };
 * ```
 *
 * @example System actor
 * ```typescript
 * const systemActor: Actor = {
 *   id: "system",
 *   name: "Background Job"
 * };
 * ```
 */
export type Actor = z.infer<typeof ActorSchema>;

/**
 * Target specification for action execution.
 *
 * Identifies which state instance (stream) should process the action
 * and who is performing it. The target combines the stream identifier
 * with actor context for complete audit trail.
 *
 * @template TActor - Actor type extending base Actor (default: Actor)
 *
 * @example Basic target
 * ```typescript
 * const target: Target = {
 *   stream: "user-123",
 *   actor: { id: "admin", name: "Admin User" }
 * };
 *
 * await app.do("updateProfile", target, { email: "new@example.com" });
 * ```
 *
 * @example Dynamic stream ID
 * ```typescript
 * const userId = "user-" + Date.now();
 * await app.do("createUser", {
 *   stream: userId,
 *   actor: currentUser
 * }, userData);
 * ```
 */
export type Target<TActor extends Actor = Actor> = {
  readonly stream: string;
  readonly actor: TActor;
  readonly expectedVersion?: number;
};

/**
 * Metadata describing the causation of an event.
 */
export type CausationEvent = z.infer<typeof CausationEventSchema>;

/**
 * Metadata attached to an event, including correlation and causation.
 */
export type EventMeta = z.infer<typeof EventMetaSchema>;

/**
 * Metadata attached to a committed event, including id, stream, version, and creation time.
 */
export type CommittedMeta = z.infer<typeof CommittedMetaSchema>;

/**
 * Query options for event store queries.
 *
 * @property `stream?` - Filter by stream name. Interpreted as a regex by default — anchors are caller-controlled (`^foo` prefix, `foo$` suffix, `^foo$` whole-string). A plain string `foo` matches any stream containing it. Semantics are identical across all stores.
 * @property `stream_exact?` - When true, treat `stream` as a literal string and use fast equality instead of regex compilation.
 * @property `names?` - Filter by event names
 * @property `before?` - Filter events before this id
 * @property `after?` - Filter events after this id
 * @property `limit?` - Limit the number of events to return
 * @property `created_before?` - Filter events created before this date/time
 * @property `created_after?` - Filter events created after this date/time
 * @property `backward?` - Order descending when true
 * @property `correlation?` - Filter by correlation
 * @property `with_snaps?` - Include snapshots in the results, defaults to false
 */
export type Query = z.infer<typeof QuerySchema>;

/**
 * Time-travel options for `load()`.
 * Filters events by position or timestamp, bypassing cache and snapshots.
 */
export type AsOf = Pick<
  Query,
  "before" | "created_before" | "created_after" | "limit"
>;

/**
 * A generic schema definition (plain object shape).
 */
export type Schema = Record<string, any>;

/**
 * A map of named schemas.
 */
export type Schemas = Record<string, Schema>;

/**
 * An empty schema (no properties).
 */
export type EmptySchema = Record<string, never>;

/**
 * Maps schema names to their Zod type representations.
 * @template T - The schemas map.
 */
export type ZodTypes<T extends Schemas> = {
  [K in keyof T]: ZodType<T[K]>;
};

/**
 * Per-action context handed to a {@link Correlator} when minting a
 * correlation id for an originating commit.
 *
 * Reactions inherit `reactingTo.meta.correlation`, so the correlator is
 * only consulted for actions that *start* a workflow.
 *
 * @property action - The action name being dispatched.
 * @property state - The resolved state name that owns this action.
 * @property stream - The target stream the action commits to.
 * @property actor - The actor invoking the action.
 */
export type CorrelatorContext = {
  readonly action: string;
  readonly state: string;
  readonly stream: string;
  readonly actor: Actor;
};

/**
 * Delegate that mints the `correlation` field on event metadata for
 * originating actions. When omitted from {@link ActOptions}, Act uses
 * a readable + index-friendly default (`{state[:4]}-{action[:4]}-{ts}{rnd}`).
 *
 * Common patterns apps plug in:
 *
 * ```ts
 * // Embed a tenant id pulled from the actor
 * const tenantPrefixed: Correlator = (ctx) =>
 *   tenantOf(ctx.actor) + "-" + defaultSuffix(ctx);
 *
 * // Propagate an inbound trace id when present
 * const tracePropagating: Correlator = (ctx) =>
 *   currentTraceId() ?? defaultCorrelator(ctx);
 * ```
 *
 * Other shapes:
 * - Use ULID / UUIDv7 if you've standardized on those elsewhere.
 * - Call a database sequence for hard-monotonic ids (one extra round-trip
 *   per commit).
 */
export type Correlator = (ctx: CorrelatorContext) => string;

/**
 * Represents a message (event or action) with a name and data payload.
 *
 * Messages are the basic building blocks of the event log. Each message
 * has a name (event type) and data (event payload).
 *
 * @template TEvents - Schemas map
 * @template TKey - Event/action name
 *
 * @example
 * ```typescript
 * const message: Message<{ Incremented: { amount: number } }, "Incremented"> = {
 *   name: "Incremented",
 *   data: { amount: 5 }
 * };
 * ```
 */
export type Message<TEvents extends Schemas, TKey extends keyof TEvents> = {
  /** The event or action name */
  readonly name: TKey;
  /** The event or action payload */
  readonly data: Readonly<TEvents[TKey]>;
  /**
   * Sensitive-data payload (#566). Carries fields the framework extracted
   * from `data` at commit-interception time, routed to a separate
   * `events.pii` column by adapters that declare the `pii_isolation`
   * capability.
   *
   * Populated by the framework's commit interception (foundation #855) —
   * action handlers do not set this. On commit input it carries the
   * extracted sensitive fields; on load output it carries the merged
   * fields read from the adapter's pii column (or `null` after
   * `Store.forget_pii(stream)`).
   *
   * Adapters without `pii_isolation` ignore the field; the framework only
   * populates it when the adapter declares capability support and the
   * event's schema has `sensitive(...)`-marked fields. (Read-time
   * visibility gating — who sees plaintext vs `[REDACTED]` — is the
   * separate concern of `state(...).discloses(predicate)` and lives in
   * the orchestrator's load path, not on the Store contract.)
   */
  readonly pii?: Readonly<Record<string, unknown>> | null;
};

/**
 * A committed event with complete metadata.
 *
 * Committed events include the message data plus metadata about when and how
 * the event was created, including correlation and causation information for
 * tracing event-driven workflows.
 *
 * @template TEvents - Schemas map
 * @template TKey - Event name
 *
 * @example
 * ```typescript
 * // Committed events include:
 * // - id: global sequence number
 * // - stream: which state instance
 * // - version: event number within stream
 * // - created: timestamp
 * // - meta: correlation and causation
 *
 * app.on("committed", (snapshots) => {
 *   snapshots.forEach(snap => {
 *     if (snap.event) {
 *       console.log(`Event ${snap.event.name} #${snap.event.id}`);
 *       console.log(`Stream: ${snap.event.stream} v${snap.event.version}`);
 *       console.log(`Data:`, snap.event.data);
 *     }
 *   });
 * });
 * ```
 *
 * @see {@link CommittedMeta} for metadata structure
 */
export type Committed<
  TEvents extends Schemas,
  TKey extends keyof TEvents,
> = Message<TEvents, TKey> & CommittedMeta;

/**
 * Snapshot of state at a specific point in time.
 *
 * Snapshots represent the current state after applying events. They include
 * metadata about how many events have been applied (patches) and how many
 * snapshots have been taken for optimization.
 *
 * @template TState - State schema
 * @template TEvents - Event schemas
 *
 * @example
 * ```typescript
 * const snapshot = await app.load(Counter, "counter-1");
 *
 * console.log(snapshot.state);     // { count: 42 }
 * console.log(snapshot.patches);   // 8 (events since last snapshot)
 * console.log(snapshot.snaps);     // 1 (1 snapshot taken)
 * console.log(snapshot.event);     // Last event that created this snapshot
 * ```
 *
 * @example Using snapshot in action handler
 * ```typescript
 * .on({ increment: z.object({ by: z.number() }) })
 *   .emit((action, snapshot) => {
 *     console.log("Current count:", snapshot.state.count);
 *     console.log("Events applied:", snapshot.patches);
 *     return ["Incremented", { amount: action.by }];
 *   })
 * ```
 */
export type Snapshot<TState extends Schema, TEvents extends Schemas> = {
  /** Current state data */
  readonly state: TState;
  /** Event that created this snapshot (undefined for initial state) */
  readonly event?: Committed<TEvents, keyof TEvents>;
  /**
   * Stream head version (sequence number of the last event in the
   * stream). `-1` for a brand-new stream with no events. Always defined
   * — populated from the cache on hit-with-no-new-events, from the last
   * replayed event on cache miss, or from the just-committed event on
   * snapshots returned by `action()`. Use this instead of
   * `event?.version` when you need the version even after a cache hit
   * skipped the event replay entirely.
   */
  readonly version: number;
  /** Number of patches applied since last snapshot */
  readonly patches: number;
  /** Number of snapshots taken for this stream */
  readonly snaps: number;
  /** Domain patch applied by this event (undefined for initial/loaded state) */
  readonly patch?: Readonly<Patch<TState>>;
  /**
   * `true` when the state was reconstructed from a cached checkpoint
   * (skipping full event replay). Set by `load()`; propagated unchanged
   * to every snapshot `action()` returns since they all derive from the
   * same initial load. Always `false` for time-travel loads, which
   * bypass the cache by design.
   */
  readonly cache_hit: boolean;
  /**
   * Number of events processed by the `load()` call that produced this
   * snapshot — counts every snap and patch event applied past the cache
   * point. `0` after a cache hit with no new events; equals the event
   * count from snap/start after a cache miss. Distinct from `patches`,
   * which is the snap-distance accumulator used by snap policies.
   * Propagated unchanged by `action()`.
   */
  readonly replayed: number;
};

/**
 * An invariant is a condition that must always hold true for a state.
 * @template TState - State schema.
 * @template TActor - Actor type extending base Actor.
 */
export type Invariant<TState extends Schema, TActor extends Actor = Actor> = {
  description: string;
  valid: (state: Readonly<TState>, actor?: TActor) => boolean;
};

/**
 * Represents an emitted event tuple from an action handler.
 * @template TEvents - Event schemas.
 */
export type Emitted<TEvents extends Schemas> = {
  [TKey in keyof TEvents]: readonly [TKey, Readonly<TEvents[TKey]>];
}[keyof TEvents];

/**
 * Bundles the Zod types for state, events, and actions.
 * @template TState - State schema.
 * @template TEvents - Event schemas.
 * @template TActions - Action schemas.
 */
export type StateSchemas<
  TState extends Schema,
  TEvents extends Schemas,
  TActions extends Schemas,
> = {
  readonly events: ZodTypes<TEvents>;
  readonly actions: ZodTypes<TActions>;
  readonly state: ZodType<TState>;
};

/**
 * Handles patching state in response to a committed event.
 * @template TState - State schema.
 * @template TEvents - Event schemas.
 * @template TKey - Event name.
 */
export type PatchHandler<
  TState extends Schema,
  TEvents extends Schemas,
  TKey extends keyof TEvents,
> = (
  event: Committed<TEvents, TKey>,
  state: Readonly<TState>
) => Readonly<Patch<TState>>;

/**
 * Maps event names to their patch handlers.
 * @template TState - State schema.
 * @template TEvents - Event schemas.
 */
export type PatchHandlers<TState extends Schema, TEvents extends Schemas> = {
  [TKey in keyof TEvents]: PatchHandler<TState, TEvents, TKey>;
};

/**
 * Internal marker for the framework-default passthrough reducer
 * (`({ data }) => data`). Custom user-supplied reducers never carry this
 * flag. The builder merger uses it to resolve patch conflicts between
 * partial states: a passthrough always yields to a custom reducer.
 *
 * @internal
 */
export type PassthroughPatchHandler = ((event: {
  data: unknown;
}) => unknown) & { readonly _passthrough: true };

/**
 * Handles an action, producing one or more emitted events.
 * @template TState - State schema.
 * @template TEvents - Event schemas.
 * @template TActions - Action schemas.
 * @template TKey - Action name.
 */
export type ActionHandler<
  TState extends Schema,
  TEvents extends Schemas,
  TActions extends Schemas,
  TKey extends keyof TActions,
> = (
  action: Readonly<TActions[TKey]>,
  snapshot: Readonly<Snapshot<TState, TEvents>>,
  target: Target
) => Emitted<TEvents> | Emitted<TEvents>[] | undefined;

/**
 * Maps action names to their handlers.
 * @template TState - State schema.
 * @template TEvents - Event schemas.
 * @template TActions - Action schemas.
 */
export type ActionHandlers<
  TState extends Schema,
  TEvents extends Schemas,
  TActions extends Schemas,
> = {
  [TKey in keyof TActions]: ActionHandler<TState, TEvents, TActions, TKey>;
};

/**
 * Maps action names to invariants that must hold after the action.
 * @template TState - State schema.
 * @template TActions - Action schemas.
 */
export type GivenHandlers<TState extends Schema, TActions extends Schemas> = {
  [TKey in keyof TActions]?: Invariant<TState>[];
};

// ---------------------------------------------------------------------------
// Retry pacing — generic, shared by every consumer that defers retries
// (reactions on the drain side, actions on the command side, future ops
// primitives). The runtime delay math lives in `internal/backoff.ts`.
// ---------------------------------------------------------------------------

/**
 * Backoff strategy for delaying the next retry attempt after a handler
 * throws.
 *
 * - `fixed` — wait `baseMs` between attempts
 * - `linear` — wait `baseMs * (retry + 1)`
 * - `exponential` — wait `baseMs * 2^retry`, capped at `maxMs` if provided
 *
 * `retry` is the attempt counter at finalize time, where `0` is the first
 * attempt that just failed. The delay applies *before* the next attempt.
 */
export type BackoffStrategy = "fixed" | "linear" | "exponential";

/**
 * Retry backoff configuration.
 *
 * @property strategy - {@link BackoffStrategy}
 * @property baseMs - Base delay (must be ≥ 0)
 * @property maxMs - Optional cap; only used by `exponential`
 * @property jitter - Multiply final delay by `0.5 + random()` (range
 *   `[0.5, 1.5)`) to avoid thundering herds when many callers retry in
 *   lockstep
 */
export type BackoffOptions = {
  readonly strategy: BackoffStrategy;
  readonly baseMs: number;
  readonly maxMs?: number;
  readonly jitter?: boolean;
};

/**
 * Per-action retry policy, declared on `state.on(entry, options)`. The
 * orchestrator owns the loop on the command path: on
 * {@link ConcurrencyError} the cache is invalidated, an optional
 * `backoff` delay is applied, and the action re-runs from `load`. Any
 * other error rethrows immediately and does not consume the budget.
 *
 * No `blockOnError` field — commands surface errors to callers; they do
 * not block streams.
 *
 * @property maxRetries - Additional attempts after the initial call.
 *   Default `0` (single attempt, current behavior). Total invocations
 *   equal `1 + maxRetries`.
 * @property backoff - Optional retry pacing. When omitted, retries run
 *   immediately — fine at low contention. Set to `{ strategy:
 *   "exponential", baseMs, jitter: true }` on hot streams where many
 *   writers contend for the same version.
 */
export type ActionOptions = {
  readonly maxRetries?: number;
  readonly backoff?: BackoffOptions;
};

/**
 * The full state definition, including schemas, handlers, and optional invariants and snapshot logic.
 * @template TState - State schema.
 * @template TEvents - Event schemas.
 * @template TActions - Action schemas.
 * @template TName - State name literal.
 */
export type State<
  TState extends Schema,
  TEvents extends Schemas,
  TActions extends Schemas,
  TName extends string = string,
> = StateSchemas<TState, TEvents, TActions> & {
  name: TName;
  init: () => Readonly<TState>;
  patch: PatchHandlers<TState, TEvents>;
  on: ActionHandlers<TState, TEvents, TActions>;
  given?: GivenHandlers<TState, TActions>;
  snap?: (snapshot: Snapshot<TState, TEvents>) => boolean;
  /**
   * Per-action retry policy keyed by action name. Set by
   * `state.on(entry, options)`; consumed by the orchestrator's command
   * path. Actions without an entry behave as if `{ maxRetries: 0 }` —
   * `ConcurrencyError` surfaces on first conflict.
   */
  options?: { [TKey in keyof TActions]?: ActionOptions };
  /**
   * Disclosure predicate set by `.discloses(predicate)`. Gates external
   * reads of `sensitive(...)`-marked fields — returning `true` allows the
   * actor to see plaintext, `false` redacts. When absent, the framework
   * default-denies on every external read (sensitive fields are always
   * substituted with `"[REDACTED]"`). See #855 / epic #566.
   */
  // The stored predicate is erased — `any` for the event makes the field
  // signature bivariant so a narrow `State<{count: number}, {Counted: ...},
  // ...>` is assignable to `State<any, any, any>` without TypeScript blocking
  // on contravariant function params. The public `.discloses()` method on the
  // builder keeps the narrow signature so users still get type-checked predicates.
  // biome-ignore lint/suspicious/noExplicitAny: erased for State<any,any,any> compatibility
  disclose?: (event: any, actor: Actor) => boolean;
};

/**
 * Extracts the raw action schemas from a State definition.
 *
 * Use this to recover the `TActions` type parameter from a built State object,
 * enabling construction of typed dispatchers without circular imports.
 *
 * @template T - A State object (or any object with `readonly actions: ZodTypes<TActions>`)
 *
 * @example
 * ```typescript
 * type Actions = InferActions<typeof Counter>;
 * // => { increment: { by: number } }
 * ```
 */
export type InferActions<
  T extends { readonly actions: Record<string, ZodType> },
> = {
  [K in keyof T["actions"]]: T["actions"][K] extends ZodType<infer V>
    ? V
    : never;
};

/**
 * Extracts the raw event schemas from a State definition.
 *
 * Use this to recover the `TEvents` type parameter from a built State object,
 * enabling typed event handling without repeating the mapped type boilerplate.
 *
 * @template T - A State object (or any object with `readonly events: ZodTypes<TEvents>`)
 *
 * @example
 * ```typescript
 * type Events = InferEvents<typeof Counter>;
 * // => { Incremented: { amount: number } }
 * ```
 */
export type InferEvents<
  T extends { readonly events: Record<string, ZodType> },
> = {
  [K in keyof T["events"]]: T["events"][K] extends ZodType<infer V> ? V : never;
};

/**
 * Per-stream options for the archive-and-truncate (or restart-with-
 * snapshot) operation.
 *
 * @see {@link IAct.close} for the close-the-books API
 */
export type CloseTarget = {
  /** Stream name to close */
  readonly stream: string;
  /** When true, restart with a `__snapshot__` of the final state.
   *  When false/omitted, permanently close with a `__tombstone__`. */
  readonly restart?: boolean;
  /** Called before truncation while the stream is guarded (no concurrent writes).
   *  Use `app.query()` or `app.query_array()` inside for pagination.
   *  If it throws, the stream remains guarded but is not truncated. */
  readonly archive?: () => Promise<void>;
};

/**
 * Result of a close operation — per-stream truncate outcomes plus the
 * names of any streams that were skipped (concurrent writes, pending
 * reactions).
 *
 * @see {@link IAct.close} for the close-the-books API
 */
export type CloseResult = {
  /** Per-stream truncate results (deleted count + committed event) */
  readonly truncated: TruncateResult;
  /** Streams skipped due to pending reactions or concurrent writes */
  readonly skipped: string[];
};

/**
 * Public interface for the Act orchestrator, passed to reaction handlers.
 *
 * Provides typed access to action dispatch, state loading, and event querying.
 * Construct with {@link InferActions} and {@link InferEvents} to avoid circular
 * imports between slice files and the bootstrap module.
 *
 * @template TEvents - Event schemas
 * @template TActions - Action schemas (maps action names to payload types)
 * @template TActor - Actor type extending base Actor
 *
 * @example
 * ```typescript
 * import type { IAct, InferActions, InferEvents } from "@rotorsoft/act";
 *
 * type App = IAct<
 *   InferEvents<typeof StateA> & InferEvents<typeof StateB>,
 *   InferActions<typeof StateA> & InferActions<typeof StateB>
 * >;
 *
 * async function myReaction(event: ..., stream: string, app: App) {
 *   await app.do("someAction", target, payload, event);
 *   const snapshot = await app.load(MyState, "stream-1");
 *   const events = await app.query_array({ stream: "stream-1" });
 * }
 * ```
 */
/**
 * Options for the orchestrator's restore scan loop, consumed by
 * {@link IAct.restore} (and threaded through to the internal `scan`).
 * Adapters never see these — they're entirely interpreted on the
 * orchestrator side.
 *
 * Compaction flags ({@link drop_snapshots}, {@link drop_closed_streams})
 * and the migration overlay ({@link event_migrations},
 * {@link stream_rename}) all apply per event before the sink writes
 * anything. Any throw aborts the whole scan — atomic rollback in the
 * sink means a failing transform leaves the target byte-for-byte
 * unchanged.
 */
export type ScanOptions = {
  /**
   * Skip events with `name === SNAP_EVENT`. The next snap policy
   * regenerates snapshots against current code; useful for backups
   * that should compact stale snapshot bytes. Counted in
   * {@link ScanResult.dropped}`.snapshots`.
   *
   * Single-pass: no source-shape implications. Default `false`.
   */
  readonly drop_snapshots?: boolean;

  /**
   * Optional progress callback. The scan loop fires it once per event
   * during iteration. Three fields:
   *
   *   - `processed` — running 1-based count of events processed.
   *   - `id` — current event's id.
   *   - `max_id` — highest id in the source, probed once at scan start
   *     via `source.query(noop, { backward: true, limit: 1 })`. O(1) on
   *     indexed stores. Left `undefined` when the probe can't determine
   *     it (e.g. `CsvFile`-style sources that ignore the filter and
   *     stream more than one event from the probe call).
   *
   * UIs render either `processed / ?` (event count) or `id / max_id`
   * (position through the id space) depending on need.
   *
   * Synchronous handler — the scan loop calls it directly.
   * **Throttling / batching is the caller's responsibility**: for a
   * million-event restore, debounce in the handler rather than
   * expecting the loop to coalesce calls. Keeping it unthrottled
   * means callers that want every-event reporting get it without a
   * config knob.
   */
  readonly on_progress?: (p: {
    processed: number;
    id: number;
    max_id?: number;
  }) => void;

  /**
   * Per-batch row count for the scan pagination loop (ACT-1133). Each
   * call to `source.query` requests `limit: batch_size` and `after:
   * <last id seen>`. Default `500`. Lower values trade round trips for
   * memory; higher values approach the cost of an unbounded query.
   */
  readonly batch_size?: number;

  /**
   * When `true`, {@link IAct.restore} runs the scan loop without
   * touching the store — events are validated and counted but no
   * transaction is opened and no rows are written. Returned `kept` /
   * `dropped` reflect what a subsequent destructive restore against
   * the same source would land; a throw means the source has a
   * blocker (the running index pinpoints it).
   *
   * No `Store.restore` capability is required for a dry-run — the
   * adapter is never called. Default `false`.
   */
  readonly dry_run?: boolean;

  /**
   * Compact streams that have been closed (tombstoned) via
   * {@link IAct.close} (ACT-1126). The scan walks the source once
   * upfront to collect streams with a `__tombstone__` event, then
   * the main loop drops every **pre-close event** whose stream is in
   * that set. The tombstone itself is **kept** — it's the gate that
   * makes {@link IAct.do} throw `StreamClosedError` in the rebuilt
   * store, so dropping it would silently reopen the stream.
   *
   * Useful for compaction during transfer: the new (migrated) store
   * keeps the close gate but drops the historical detail.
   *
   * Counted in {@link ScanResult.dropped}`.closed_streams` (pre-close
   * events only; the tombstone is counted in `kept`).
   *
   * Default `false`.
   */
  readonly drop_closed_streams?: boolean;

  /**
   * Per-event migrations applied during scan (ACT-1126). Keys are
   * source event names; values describe how to rewrite the event into
   * its current-version form before the sink writes it.
   *
   * Transfer-time only — never registered at app build time and never
   * auto-applied to a live store. Operators configure migrations
   * explicitly per-call (typically through the inspector's transfer
   * dialog when moving from an old store to a new one).
   *
   * Each row that matches a key:
   *   1. parses `event.data` against `from_schema` (validates source);
   *   2. runs `migrate(parsed)` to transform the payload;
   *   3. parses the result against `to_schema` (validates target);
   *   4. is rewritten with `name = to` and `data = migrated`.
   *
   * Any throw aborts the whole scan — atomic transaction rollback in
   * the sink means a failing migration leaves the target byte-for-byte
   * unchanged.
   */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous per-key migrations
  readonly event_migrations?: Record<string, EventMigration<any, any>>;

  /**
   * Per-stream rename applied during scan (ACT-1126). Called once per
   * event; the returned string replaces `event.stream`. Useful for
   * tenant relocation (`s => s.replace(/^old-tenant-/, "new-tenant-")`)
   * or prefix cleanup.
   *
   * Applied AFTER {@link event_migrations} so the migration sees the
   * original stream name (in case the migration's `migrate` function
   * inspects it).
   */
  readonly stream_rename?: (stream: string) => string;
};

/**
 * Per-event migration definition for {@link ScanOptions.event_migrations}.
 * Carries both the rename target and the schema-guarded transform that
 * rewrites the event's `data` payload (ACT-1126).
 */
export type EventMigration<TOld, TNew> = {
  /** Target event name (the current version). */
  readonly to: string;
  /** Schema of the source event's `data`. Throws on mismatch. */
  readonly from_schema: { parse: (data: unknown) => TOld };
  /** Schema of the migrated event's `data`. Throws on mismatch. */
  readonly to_schema: { parse: (data: unknown) => TNew };
  /** Pure data transformer. */
  readonly migrate: (data: TOld) => TNew;
};

/**
 * Result of {@link IAct.restore}.
 *
 * `kept` and `duration_ms` are always populated. `dropped` carries
 * per-category counters when {@link ScanOptions.drop_snapshots} (or
 * future compaction flags) trigger drops; otherwise zeros. Live
 * restore is atomic — any error throws and rolls back, so there's no
 * per-event error reporting on the result.
 */
export type ScanResult = {
  /** Number of events written to the rebuilt store. */
  readonly kept: number;
  /** Wall-clock duration of the call, in milliseconds. */
  readonly duration_ms: number;
  /** Per-category drop counters. */
  readonly dropped: {
    readonly closed_streams: number;
    readonly snapshots: number;
  };
  /** Events rewritten by {@link ScanOptions.event_migrations}. */
  readonly migrated: number;
};

/**
 * Read end of the transfer pipeline (ACT-1128 / #788). Anything
 * that exposes a `Store.query`-shaped reader plus `dispose` can be
 * used as a source for {@link IAct.restore}.
 *
 * `Store` extends this interface; the framework's `CsvFile` utility
 * implements it on top of file I/O so a CSV can be a transfer
 * source. The pipeline never sees a discriminator — both ends speak
 * the same shape.
 */
export interface EventSource extends Disposable {
  /**
   * Read events into a per-event callback. Adapters MUST `await
   * Promise.resolve(callback(event))` per event — sync callbacks
   * resolve immediately (zero overhead), async callbacks throttle
   * the read loop. This is the seam that lets `iterate()` apply
   * backpressure without changing the callback's declared return
   * type. Callback returns `void`, which TypeScript treats as
   * "return value ignored" — existing call sites passing
   * `e => arr.push(e)` (which returns `number`) keep working.
   */
  query<E extends Schemas>(
    callback: (event: Committed<E, keyof E>) => void,
    query?: Query
  ): Promise<number>;
}

/**
 * Write end of the transfer pipeline (ACT-1128 / #788). Anything
 * that can host the destructive driver-pattern `restore` HOF (atomic
 * wipe + per-event commit) is an `EventSink` — `Store` adapters
 * that ship the optional `restore` method, plus the framework's
 * `CsvFile` utility for "write to a file" targets.
 *
 * `restore` is required here (vs. optional on `Store`) because the
 * sink slot in {@link IAct.restore} demands a writer; non-restorable
 * stores satisfy {@link EventSource} only.
 */
export interface EventSink extends Disposable {
  restore(
    driver: (
      callback: (event: Committed<Schemas, keyof Schemas>) => Promise<number>
    ) => Promise<void>
  ): Promise<void>;
}

export interface IAct<
  TEvents extends Schemas = Schemas,
  TActions extends Schemas = Schemas,
  TActor extends Actor = Actor,
> {
  do<TKey extends keyof TActions & string>(
    action: TKey,
    target: Target<TActor>,
    payload: Readonly<TActions[TKey]>,
    reactingTo?: Committed<Schemas, string>,
    skipValidation?: boolean
  ): Promise<Snapshot<any, any>[]>;

  load(
    state: State<any, any, any> | string,
    stream: string,
    callback?: (snapshot: Snapshot<any, any>) => void,
    asOf?: AsOf
  ): Promise<Snapshot<any, any>>;

  query(
    query: Query,
    callback?: (event: Committed<TEvents, keyof TEvents>) => void
  ): Promise<{
    first?: Committed<TEvents, keyof TEvents>;
    last?: Committed<TEvents, keyof TEvents>;
    count: number;
  }>;

  query_array(query: Query): Promise<Committed<TEvents, keyof TEvents>[]>;
}
