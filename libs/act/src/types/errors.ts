import type { Msg, RecRec, Target } from "../types";

/**
 * Application error types
 * - `ERR_VALIDATION` schema validation error
 * - `ERR_INVARIANT` invariant validation error
 * - `ERR_CONCURRENCY` optimistic concurrency validation error on commits
 * - `ERR_REGISTRATION` schema registration error
 */
export const Errors = {
  ValidationError: "ERR_VALIDATION",
  InvariantError: "ERR_INVARIANT",
  ConcurrencyError: "ERR_CONCURRENCY",
  ActorConcurrencyError: "ERR_ACTOR_CONCURRENCY",
  RegistrationError: "ERR_REGISTRATION"
} as const;

export class ValidationError extends Error {
  constructor(public details: any) {
    super("Invalid message payload");
    this.name = Errors.ValidationError;
  }
}

export class InvariantError<M extends RecRec> extends Error {
  public readonly details;
  constructor(
    name: keyof M,
    data: Readonly<M[keyof M]>,
    target: Target,
    description: string
  ) {
    super(`${name as string} failed invariant: ${description}`);
    this.name = Errors.InvariantError;
    this.details = { name, data, target, description };
  }
}

export class ConcurrencyError<E extends RecRec> extends Error {
  constructor(
    public readonly lastVersion: number,
    public readonly events: Msg<E, keyof E>[],
    public readonly expectedVersion: number
  ) {
    super(
      `Concurrency error committing event "${
        events.at(0)?.name as string
      }". Expected version ${expectedVersion} but found version ${lastVersion}.`
    );
    this.name = Errors.ConcurrencyError;
  }
}

export class RegistrationError extends Error {
  constructor(message: string) {
    super(`Message "${message}" not registered with app builder!`);
    this.name = Errors.RegistrationError;
  }
}
