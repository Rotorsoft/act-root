import type { Message, Schema, Schemas, Target } from "./action.js";

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
 * Thrown when a payload fails schema validation.
 * @param target - The name of the target being validated (e.g., event, action).
 * @param payload - The invalid payload.
 * @param details - Additional validation error details.
 * @example
 *   throw new ValidationError('event', payload, zodError);
 */
export class ValidationError extends Error {
  constructor(
    public readonly target: string,
    public readonly payload: any,
    public readonly details: any
  ) {
    super(`Invalid ${target} payload`);
    this.name = Errors.ValidationError;
  }
}

/**
 * Thrown when a state invariant is violated after an action or event.
 * @param name - The name of the invariant or action.
 * @param payload - The state or payload that failed the invariant.
 * @param target - The target context (e.g., stream, actor).
 * @param description - Description of the invariant.
 * @example
 *   throw new InvariantError('balanceNonNegative', state, target, 'Balance must be >= 0');
 */
export class InvariantError extends Error {
  public readonly details;
  constructor(
    name: string,
    payload: Schema,
    target: Target,
    description: string
  ) {
    super(`${name} failed invariant: ${description}`);
    this.name = Errors.InvariantError;
    this.details = { name, payload, target, description };
  }
}

/**
 * Thrown when an optimistic concurrency check fails during event commit.
 * @param lastVersion - The last known version in the stream.
 * @param events - The events being committed.
 * @param expectedVersion - The expected version for the commit.
 * @example
 *   throw new ConcurrencyError(2, events, 1);
 */
export class ConcurrencyError extends Error {
  constructor(
    public readonly stream: string,
    public readonly lastVersion: number,
    public readonly events: Message<Schemas, keyof Schemas>[],
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
