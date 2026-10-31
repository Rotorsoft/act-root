import type {
  Actor,
  DeferWhen,
  Message,
  Schema,
  Schemas,
  Snapshot,
  Target,
} from "./action.js";

/**
 * @packageDocumentation
 * @module act/types
 * @category Types
 * Application error type constants and error classes for the Act Framework.
 *
 * - `ERR_VALIDATION`: Schema validation error
 * - `ERR_PRECONDITION`: A precondition refused the action
 * - `ERR_INVARIANT`: A deprecated `.given` rule refused the action
 * - `ERR_CONCURRENCY`: Optimistic concurrency validation error on commits
 */
export const Errors = {
  ValidationError: "ERR_VALIDATION",
  PreconditionError: "ERR_PRECONDITION",
  /** @deprecated `.given` rules are preconditions; use `PreconditionError`. Removed in 2.0. */
  InvariantError: "ERR_INVARIANT",
  ConcurrencyError: "ERR_CONCURRENCY",
  StreamClosedError: "ERR_STREAM_CLOSED",
  NonRetryableError: "ERR_NON_RETRYABLE",
  StoreError: "ERR_STORE",
} as const;

/**
 * Thrown when an action or event payload fails Zod schema validation.
 *
 * This error indicates that data doesn't match the expected schema defined
 * for an action or event. The `details` property contains the Zod validation
 * error with specific information about what failed.
 *
 * @example Catching validation errors
 * ```typescript
 * import { ValidationError } from "@rotorsoft/act";
 *
 * try {
 *   await app.do("createUser", target, {
 *     email: "invalid-email",  // Missing @ symbol
 *     age: -5                  // Negative age
 *   });
 * } catch (error) {
 *   if (error instanceof ValidationError) {
 *     console.error("Validation failed for:", error.target);
 *     console.error("Invalid payload:", error.payload);
 *     console.error("Validation details:", error.details);
 *     // details contains Zod error with field-level info
 *   }
 * }
 * ```
 *
 * @see {@link https://zod.dev | Zod documentation} for validation details
 */
export class ValidationError extends Error {
  /** The type of target being validated (e.g., "action", "event") */
  public readonly target: string;
  /** The invalid payload that failed validation */
  public readonly payload: any;
  /** Zod validation error details */
  public readonly details: any;

  constructor(target: string, payload: any, details: any) {
    super(`Invalid ${target} payload`);
    this.name = Errors.ValidationError;
    this.target = target;
    this.payload = payload;
    this.details = details;
  }
}

/**
 * Thrown when a rule declared with the deprecated `.given([...])` refuses
 * an action, with the message `"<action> failed invariant: <description>"`.
 *
 * Those rules were always preconditions, not invariants: what must hold
 * after every action lives in the state's schema. {@link PreconditionError}
 * extends this class, so `instanceof InvariantError` still catches every
 * refused action.
 *
 * @deprecated Declare the rule with `.requires([...])` and catch
 * {@link PreconditionError}. Removed in 2.0.
 *
 * @template TState - State schema type
 * @template TEvents - Event schemas type
 * @template TActions - Action schemas type
 * @template TKey - Action name
 * @template TActor - Actor type extending base Actor
 */
export class InvariantError<
  TState extends Schema,
  TEvents extends Schemas,
  TActions extends Schemas,
  TKey extends keyof TActions,
  TActor extends Actor = Actor,
> extends Error {
  /** The action that was attempted */
  readonly action: TKey;
  /** The action payload that was provided */
  readonly payload: Readonly<TActions[TKey]>;
  /** The target stream and actor context */
  readonly target: Target<TActor>;
  /** The current state snapshot when the rule was checked */
  readonly snapshot: Snapshot<TState, TEvents>;
  /** Human-readable description of the rule that refused the action */
  readonly description: string;

  /**
   * @param rule - Which layer refused the action: a `.given([...])` rule
   *   (the default) or a precondition from `.requires([...])`. It names the
   *   layer in the message.
   */
  constructor(
    action: TKey,
    payload: Readonly<TActions[TKey]>,
    target: Target<TActor>,
    snapshot: Snapshot<TState, TEvents>,
    description: string,
    rule: "invariant" | "precondition" = "invariant"
  ) {
    super(`${action as string} failed ${rule}: ${description}`);
    this.name = Errors.InvariantError;
    this.action = action;
    this.payload = payload;
    this.target = target;
    this.snapshot = snapshot;
    this.description = description;
  }
}

/**
 * Thrown when a precondition from `.requires([...])` refuses an action,
 * with the message `"<action> failed precondition: <description>"`.
 *
 * Preconditions are what the caller must meet for the action to run now.
 * They're checked after loading the current state and before the handler
 * emits anything, so nothing is stored. Invariants (what must hold after
 * every action) live in the state's schema instead; a broken one throws
 * {@link ValidationError}.
 *
 * It extends the deprecated {@link InvariantError} until 2.0, so code that
 * catches `InvariantError` keeps catching every refused action.
 *
 * @template TState - State schema type
 * @template TEvents - Event schemas type
 * @template TActions - Action schemas type
 * @template TKey - Action name
 * @template TActor - Actor type extending base Actor
 *
 * @example Catching a refused action
 * ```typescript
 * import { PreconditionError } from "@rotorsoft/act";
 *
 * try {
 *   await app.do("withdraw",
 *     { stream: "account-123", actor: { id: "user1", name: "Alice" } },
 *     { amount: 1000 }
 *   );
 * } catch (error) {
 *   if (error instanceof PreconditionError) {
 *     console.error("Action:", error.action);
 *     console.error("Reason:", error.description);
 *     console.error("Current state:", error.snapshot.state);
 *     console.error("Attempted payload:", error.payload);
 *   }
 * }
 * ```
 *
 * @see {@link Precondition} for declaring them
 */
export class PreconditionError<
  TState extends Schema,
  TEvents extends Schemas,
  TActions extends Schemas,
  TKey extends keyof TActions,
  TActor extends Actor = Actor,
> extends InvariantError<TState, TEvents, TActions, TKey, TActor> {
  constructor(
    action: TKey,
    payload: Readonly<TActions[TKey]>,
    target: Target<TActor>,
    snapshot: Snapshot<TState, TEvents>,
    description: string
  ) {
    super(action, payload, target, snapshot, description, "precondition");
    this.name = Errors.PreconditionError;
  }
}

/**
 * Thrown when optimistic concurrency control detects a conflict.
 *
 * This error occurs when trying to commit events to a stream that has been
 * modified by another process since it was last loaded. The version number
 * doesn't match expectations, indicating a concurrent modification.
 *
 * This is a normal occurrence in distributed systems. Declare a retry
 * budget on the action and the orchestrator reloads the state and runs it
 * again; a conflict on a caller-pinned `expectedVersion` is never retried.
 *
 * @example Declaring the retry on the action
 * ```typescript
 * const Account = state({ Account: schema })
 *   // ...
 *   .on({ transfer: TransferSchema }, {
 *     maxRetries: 3,
 *     backoff: { strategy: "exponential", baseMs: 100 },
 *   })
 *   .emit("TransferSent");
 * ```
 *
 * @see {@link Store.commit} for version checking details
 */
export class ConcurrencyError extends Error {
  /** The stream that had the concurrent modification */
  public readonly stream: string;
  /** The actual current version in the store */
  public readonly lastVersion: number;
  /** The events that were being committed */
  public readonly events: Message<Schemas, keyof Schemas>[];
  /** The version number that was expected */
  public readonly expectedVersion: number;

  constructor(
    stream: string,
    lastVersion: number,
    events: Message<Schemas, keyof Schemas>[],
    expectedVersion: number
  ) {
    // Message lists stream + event names only. Payloads remain accessible
    // via `error.events` for callers who need them — keeping them out of
    // the message avoids MB-scale strings on contended writes and keeps
    // potentially-sensitive data out of log streams.
    super(
      `Concurrency error committing "${events
        .map((e) => `${stream}.${e.name}`)
        .join(
          ", "
        )}". Expected version ${expectedVersion} but found version ${lastVersion}.`
    );
    this.name = Errors.ConcurrencyError;
    this.stream = stream;
    this.lastVersion = lastVersion;
    this.events = events;
    this.expectedVersion = expectedVersion;
  }
}

/**
 * Thrown when attempting to write to a stream that has been closed
 * with a tombstone event.
 *
 * A tombstoned stream is permanently closed — no further actions can
 * be executed against it. The only way to reopen a tombstoned stream
 * is through `Act.close()` with a `restart` callback.
 *
 * @example
 * ```typescript
 * import { StreamClosedError } from "@rotorsoft/act";
 *
 * try {
 *   await app.do("updateTicket", target, payload);
 * } catch (error) {
 *   if (error instanceof StreamClosedError) {
 *     console.error(`Stream ${error.stream} is closed`);
 *   }
 * }
 * ```
 *
 * @see {@link Act.close} for closing streams
 */
export class StreamClosedError extends Error {
  /** The stream that is closed */
  public readonly stream: string;

  constructor(stream: string) {
    super(`Stream "${stream}" is closed (tombstoned)`);
    this.name = Errors.StreamClosedError;
    this.stream = stream;
  }
}

/**
 * Thrown by a {@link Store} adapter when an infrastructure operation fails
 * for a reason that is *not* a domain condition — a dropped connection, a
 * transaction rollback, a query timeout. It is the typed boundary between
 * "the store is unavailable/degraded" and the domain errors above
 * ({@link ConcurrencyError}, {@link StreamClosedError}), which describe
 * legitimate outcomes the caller should branch on.
 *
 * Adapters wrap their driver errors in `StoreError` (preserving the
 * original via `cause`) so the orchestrator can distinguish a degraded
 * backend from "no work" and react accordingly — see the drain circuit
 * breaker, which trips on repeated `StoreError`s and surfaces an
 * `error` lifecycle event instead of silently spinning on a down
 * database.
 *
 * @example
 * ```typescript
 * app.on("error", ({ error, circuit }) => {
 *   if (error instanceof StoreError)
 *     alert(`store ${error.operation} failing; circuit=${circuit}`);
 * });
 * ```
 */
export class StoreError extends Error {
  /** The store operation that failed (e.g. `"claim"`, `"ack"`, `"commit"`). */
  public readonly operation: string;

  constructor(operation: string, options?: { cause?: unknown }) {
    super(`Store operation "${operation}" failed`, options);
    this.name = Errors.StoreError;
    this.operation = operation;
  }
}

/**
 * Thrown by a reaction handler to signal that the failure is permanent
 * and the drain pipeline should block the stream immediately, without
 * consuming the rest of the `maxRetries` budget.
 *
 * The drain finalizer detects `instanceof NonRetryableError` and forces
 * `block = options.blockOnError` regardless of `lease.retry`. When
 * `blockOnError` is `false`, behavior is unchanged (drain keeps retrying
 * forever) — the class never overrides the operator's explicit "never
 * block" choice.
 *
 * Use this for failures the handler *knows* won't get better on retry:
 * a 4xx from a webhook, a `ZodError` on malformed input, a "user
 * deleted" 404 from a downstream API. Use regular `Error` (or a
 * subclass) for transient failures so the existing retry-with-backoff
 * loop applies.
 *
 * @example Wrapping a permanent downstream error
 * ```typescript
 * import { NonRetryableError } from "@rotorsoft/act";
 *
 * .on("OrderConfirmed")
 *   .do(async function notifyPartner(event) {
 *     const res = await fetch(url, ...);
 *     if (res.status >= 400 && res.status < 500) {
 *       throw new NonRetryableError(
 *         `webhook ${url} responded ${res.status}`,
 *         { cause: await res.text() }
 *       );
 *     }
 *     if (!res.ok) throw new Error(`webhook ${url} responded ${res.status}`);
 *   })
 * ```
 */
export class NonRetryableError extends Error {
  /** The original failure, if any. Mirrors the standard `Error.cause` shape. */
  public override readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = Errors.NonRetryableError;
    this.cause = options?.cause;
  }
}

/**
 * The control-flow signal a reaction handler throws to *defer* itself.
 * Unlike an error, a defer is not a failure: the dispatcher
 * (`build_handle`) catches it and produces a
 * `HandleResult.defer` — the triggering events stay pending (watermark not
 * advanced), `retry` is not bumped, and the drain re-visits the stream at the
 * resolved due-time.
 *
 * `DeferSignal` is the **imperative escape hatch** and is re-exported from the
 * package root, so reaction code can throw it directly when a static
 * `.defer(when)` step isn't expressive enough (a deadline computed from loaded
 * state, say). It carries the *unresolved* {@link DeferWhen}; the dispatcher
 * resolves it against the triggering event it is already dispatching (via
 * `resolve_defer_at`), which is what anchors `{ after }` and the `at` function
 * form to that event and keeps the due-time derivable. Fully dynamic times go
 * through `{ at: someDate }`.
 *
 * Modeled as an `Error` subclass — like `NonRetryableError` — so it rides the
 * existing `try/catch` in the handler loop instead of needing a separate
 * return channel through every dispatcher signature. The compiled autoclose
 * reaction throws the same signal.
 */

export class DeferSignal extends Error {
  /**
   * The unresolved schedule. The dispatcher turns this into an absolute
   * due-time by resolving it against the triggering event.
   */
  readonly when: DeferWhen;

  constructor(when: DeferWhen) {
    super("reaction deferred");
    this.name = "DeferSignal";
    this.when = when;
  }
}
