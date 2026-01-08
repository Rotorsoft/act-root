import type { Message, Schema, Schemas, Snapshot, Target } from "./action.js";

/**
 * @packageDocumentation
 * @module act/types
 * @category Types
 * Application error type constants and error classes for the Act Framework.
 *
 * - `ERR_VALIDATION`: Schema validation error
 * - `ERR_INVARIANT`: Invariant validation error
 * - `ERR_CONCURRENCY`: Optimistic concurrency validation error on commits
 */
export const Errors = {
  ValidationError: "ERR_VALIDATION",
  InvariantError: "ERR_INVARIANT",
  ConcurrencyError: "ERR_CONCURRENCY",
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
 * @example Logging validation details
 * ```typescript
 * try {
 *   await app.do("updateProfile", target, payload);
 * } catch (error) {
 *   if (error instanceof ValidationError) {
 *     error.details.errors.forEach((err) => {
 *       console.error(`Field ${err.path.join(".")}: ${err.message}`);
 *     });
 *   }
 * }
 * ```
 *
 * @see {@link https://zod.dev | Zod documentation} for validation details
 */
export class ValidationError extends Error {
  constructor(
    /** The type of target being validated (e.g., "action", "event") */
    public readonly target: string,
    /** The invalid payload that failed validation */
    public readonly payload: any,
    /** Zod validation error details */
    public readonly details: any
  ) {
    super(`Invalid ${target} payload`);
    this.name = Errors.ValidationError;
  }
}

/**
 * Thrown when a business rule (invariant) is violated during action execution.
 *
 * Invariants are conditions that must hold true for an action to succeed.
 * They're checked after loading the current state but before emitting events.
 * This error provides complete context about what action was attempted and
 * why it was rejected.
 *
 * @template S - State schema type
 * @template E - Event schemas type
 * @template A - Action schemas type
 * @template K - Action name
 *
 * @example Catching invariant violations
 * ```typescript
 * import { InvariantError } from "@rotorsoft/act";
 *
 * try {
 *   await app.do("withdraw",
 *     { stream: "account-123", actor: { id: "user1", name: "Alice" } },
 *     { amount: 1000 }
 *   );
 * } catch (error) {
 *   if (error instanceof InvariantError) {
 *     console.error("Action:", error.action);
 *     console.error("Reason:", error.description);
 *     console.error("Current state:", error.snapshot.state);
 *     console.error("Attempted payload:", error.payload);
 *   }
 * }
 * ```
 *
 * @example User-friendly error messages
 * ```typescript
 * try {
 *   await app.do("closeTicket", target, payload);
 * } catch (error) {
 *   if (error instanceof InvariantError) {
 *     // Present friendly message to user
 *     if (error.description === "Ticket must be open") {
 *       return { error: "This ticket is already closed" };
 *     } else if (error.description === "Not authorized") {
 *       return { error: "You don't have permission to close this ticket" };
 *     }
 *   }
 * }
 * ```
 *
 * @example Logging with context
 * ```typescript
 * try {
 *   await app.do("transfer", target, { to: "account2", amount: 500 });
 * } catch (error) {
 *   if (error instanceof InvariantError) {
 *     logger.error({
 *       action: error.action,
 *       stream: error.target.stream,
 *       actor: error.target.actor,
 *       reason: error.description,
 *       balance: error.snapshot.state.balance,
 *       attempted: error.payload.amount
 *     }, "Invariant violation");
 *   }
 * }
 * ```
 *
 * @see {@link Invariant} for defining business rules
 */
export class InvariantError<
  S extends Schema,
  E extends Schemas,
  A extends Schemas,
  K extends keyof A,
> extends Error {
  constructor(
    /** The action that was attempted */
    readonly action: K,
    /** The action payload that was provided */
    readonly payload: Readonly<A[K]>,
    /** The target stream and actor context */
    readonly target: Target,
    /** The current state snapshot when invariant was checked */
    readonly snapshot: Snapshot<S, E>,
    /** Human-readable description of why the invariant failed */
    readonly description: string
  ) {
    super(`${action as string} failed invariant: ${description}`);
    this.name = Errors.InvariantError;
  }
}

/**
 * Thrown when optimistic concurrency control detects a conflict.
 *
 * This error occurs when trying to commit events to a stream that has been
 * modified by another process since it was last loaded. The version number
 * doesn't match expectations, indicating a concurrent modification.
 *
 * This is a normal occurrence in distributed systems and should be handled
 * by reloading the current state and retrying the action.
 *
 * @example Handling concurrency conflicts with retry
 * ```typescript
 * import { ConcurrencyError } from "@rotorsoft/act";
 *
 * async function transferWithRetry(from, to, amount, maxRetries = 3) {
 *   for (let attempt = 0; attempt < maxRetries; attempt++) {
 *     try {
 *       await app.do("transfer",
 *         { stream: from, actor: currentUser },
 *         { to, amount }
 *       );
 *       return { success: true };
 *     } catch (error) {
 *       if (error instanceof ConcurrencyError) {
 *         if (attempt < maxRetries - 1) {
 *           console.log(`Concurrent modification detected, retrying... (${attempt + 1}/${maxRetries})`);
 *           await sleep(100 * Math.pow(2, attempt)); // Exponential backoff
 *           continue;
 *         }
 *       }
 *       throw error;
 *     }
 *   }
 *   return { success: false, reason: "Too many concurrent modifications" };
 * }
 * ```
 *
 * @example Logging concurrency conflicts
 * ```typescript
 * try {
 *   await app.do("updateInventory", target, payload);
 * } catch (error) {
 *   if (error instanceof ConcurrencyError) {
 *     logger.warn({
 *       stream: error.stream,
 *       expectedVersion: error.expectedVersion,
 *       actualVersion: error.lastVersion,
 *       events: error.events.map(e => e.name)
 *     }, "Concurrent modification detected");
 *   }
 * }
 * ```
 *
 * @example User feedback for conflicts
 * ```typescript
 * try {
 *   await app.do("editDocument", target, { content: newContent });
 * } catch (error) {
 *   if (error instanceof ConcurrencyError) {
 *     return {
 *       error: "This document was modified by another user. Please refresh and try again.",
 *       code: "CONCURRENT_MODIFICATION"
 *     };
 *   }
 * }
 * ```
 *
 * @see {@link Store.commit} for version checking details
 */
export class ConcurrencyError extends Error {
  constructor(
    /** The stream that had the concurrent modification */
    public readonly stream: string,
    /** The actual current version in the store */
    public readonly lastVersion: number,
    /** The events that were being committed */
    public readonly events: Message<Schemas, keyof Schemas>[],
    /** The version number that was expected */
    public readonly expectedVersion: number
  ) {
    super(
      `Concurrency error committing "${events
        .map((e) => `${stream}.${e.name}.${JSON.stringify(e.data)}`)
        .join(
          ", "
        )}". Expected version ${expectedVersion} but found version ${lastVersion}.`
    );
    this.name = Errors.ConcurrencyError;
  }
}
