/**
 * An error thrown by application code (a resolver, a close archive callback)
 * while a framework loop was running it. The loops keep it off the store
 * circuit breaker: the store is healthy, the code is not.
 */
export class AppCodeError extends Error {
  constructor(context: string, cause: unknown) {
    super(
      `${context}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
    this.name = "AppCodeError";
  }
}
