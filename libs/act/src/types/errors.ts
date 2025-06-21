import type { Message, Schema, Schemas, Target } from "./action.js";

/**
 * Application error types
 * - `ERR_VALIDATION` schema validation error
 * - `ERR_INVARIANT` invariant validation error
 * - `ERR_CONCURRENCY` optimistic concurrency validation error on commits
 */
export const Errors = {
  ValidationError: "ERR_VALIDATION",
  InvariantError: "ERR_INVARIANT",
  ConcurrencyError: "ERR_CONCURRENCY",
} as const;

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

export class ConcurrencyError extends Error {
  constructor(
    public readonly lastVersion: number,
    public readonly events: Message<Schemas, keyof Schemas>[],
    public readonly expectedVersion: number
  ) {
    super(
      `Concurrency error committing event "${
        events.at(0)?.name
      }". Expected version ${expectedVersion} but found version ${lastVersion}.`
    );
    this.name = Errors.ConcurrencyError;
  }
}
