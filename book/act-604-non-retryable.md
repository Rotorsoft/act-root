# ACT-604 — `NonRetryableError`: the handler-signaled block

## The gap ACT-602 left

When the webhook helper from ACT-602 first landed, its README documented an honest limitation: 4xx responses are *tagged* as non-retryable on the error, but the drain pipeline doesn't differentiate. A 400 response would be retried up to `maxRetries` just like a 503, burning attempts on a payload that won't get better on retry. Callers wanting strict client-error semantics had to set `maxRetries: 0` on the reaction — a sledgehammer that also blocked real transient failures on the first attempt.

The gap was small but principled. The framework already had a "retry-vs-block" decision point — `finalize()` in `internal/reactions.ts` — but it consulted exactly one signal: the lease's retry counter against `maxRetries`. Error type was invisible. ACT-604 closed that gap with about ten lines of code.

## The change

A new exported class:

```ts
export class NonRetryableError extends Error {
  readonly cause?: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ERR_NON_RETRYABLE";
    this.cause = options?.cause;
  }
}
```

And a single new branch in the finalizer:

```ts
const nonRetryable = error instanceof NonRetryableError;
const block =
  options.blockOnError &&
  (nonRetryable || lease.retry >= options.maxRetries);
```

That's it. The class is a marker — instances of it (or any subclass) tell the drain "this is permanent, block now." Plain `Error` keeps its current semantics: retry up to `maxRetries`, then block. The retry budget exists for transient failures; permanent failures opt out via the type system.

## The asymmetry that makes it safe

The most important design decision in ACT-604 is what `NonRetryableError` does *not* do: it doesn't override `blockOnError: false`. If the operator explicitly chose "retry forever, never block" — as some teams do for sinks that *must* eventually succeed — the framework respects that choice. The non-retryable signal degrades to "treat like a regular error" in that mode.

The check is one Boolean AND:

```ts
options.blockOnError && (nonRetryable || lease.retry >= options.maxRetries)
```

Block only when `blockOnError` is true *and* either the error is non-retryable *or* the retry budget is exhausted. The operator's "never block" choice wins; the handler's "this is permanent" signal is conditional on the operator wanting blocking semantics at all.

This is the same shape the framework uses elsewhere when handler intent and operator policy interact: handler signals, operator policy decides. The TypeScript type system gets to express new failure shapes without dragging operational policy along for the ride.

## Why a class, not a flag

The naïve design would have been an option: `throw new Error("...", { retryable: false })`, or a thrown object with a `retryable: false` field. Both work. Neither is discoverable from a stack trace or a log line.

`NonRetryableError` is a class so that:

1. **It's greppable.** `instanceof NonRetryableError` works in any catch block. `throw err.retryable === false ? ...` doesn't surface in IDE autocomplete.
2. **Subclasses inherit the signal.** `NonRetryableWebhookError extends NonRetryableError` automatically participates in the finalizer check — no need for the helper to remember to set a flag.
3. **The name field carries.** `err.name === "ERR_NON_RETRYABLE"` (or a subclass name) appears in serialized logs, telemetry, error reports — operators see the classification without joining back to error properties.
4. **Cause-chaining is standard.** The `cause` field follows the ES2022 `Error.cause` convention. Existing tools that walk error chains pick it up for free.

The book chapter on schema-evolution-style "framework enforces what types can't" applies here: TypeScript can't tell whether a 4xx is permanent or transient, but a class hierarchy can carry that knowledge from the handler to the dispatcher unambiguously.

## The webhook helper updates in lockstep

ACT-602's webhook helper had a single `WebhookError extends Error` with a `retryable: boolean` flag, which was informational only. With ACT-604 landed, the helper splits into two classes:

- `WebhookError extends Error` — retryable cases (5xx, network, timeout)
- `NonRetryableWebhookError extends NonRetryableError` — 4xx responses

The `retryable` flag is gone — the class itself is the signal. The drain finalizer recognizes the subclass relationship without any helper-specific code, so the 4xx path now does what the original ACT-602 ticket promised: block on the first failed attempt, no wasted retries.

A small breaking change to `@rotorsoft/act-http@0.1.0`, but the package was one release old and the API improvement is clear: catch sites no longer need to read a boolean field, they read the type.

## What this means for other helpers

The pattern generalizes. Any helper that knows a class of failures is permanent can throw a subclass of `NonRetryableError`:

- A queue forwarder that gets a "queue does not exist" — non-retryable until the queue is created.
- A database write helper that gets a `unique violation` on a non-idempotent insert — non-retryable; the row already exists.
- A schema-validator handler that rejects malformed input — non-retryable; the input won't reformat itself.

User code in regular reaction handlers gets the same primitive. A handler that wraps third-party SDK calls can map known-permanent error codes to `NonRetryableError`:

```ts
.on("PaymentReceived")
  .do(async (event) => {
    try {
      await stripe.charges.create({ ... });
    } catch (err) {
      if (err.code === "card_declined" || err.code === "card_expired") {
        throw new NonRetryableError(`payment failed permanently: ${err.code}`, {
          cause: err,
        });
      }
      throw err; // transient — let drain retry
    }
  })
```

This is the leverage of a small primitive: one ten-line change in core, exported as one class, enables every helper and every user handler to express recoverability through the type system.

## What's deliberately out of scope

Three follow-ups parked at ticket-filing time, worth noting because they'll come up:

- **`Retry-After` header parsing.** A 429 or 503 with `Retry-After` carries a hint about *when* to retry. The helper could thread that into the backoff timer. Useful, but separate — file when there's evidence of demand.
- **Per-handler `shouldBlock(error): boolean` option.** A predicate on `ReactionOptions` would generalize the class-based approach further — handlers without their own error subclass could classify inline. Probably overkill for the 80% case; the class shape is discoverable and composable.
- **`NonRetryableError` from action handlers.** This ticket scopes the change to reaction handlers (the drain pipeline). Action handlers already throw `InvariantError` / `ValidationError`, which fail the action and propagate to the caller — a different code path with different semantics. If action callers want a generic "this is permanent, don't bother" channel, that's a separate design.

## The narrative arc

ACT-601 added the retry-pacing knob. ACT-602 added the most-asked-for delivery helper. ACT-604 closes the small but visible gap between them: helpers and handlers can now signal "permanent" through the type system, and the pipeline blocks accordingly. The integration triplet (601 → 602 → 603, with 604 slotting in next to 602) lands a coherent story: drain knows how to retry transient failures with backoff, how to deliver to external systems with webhook, and how to recognize permanent failures so neither budget nor backoff window is wasted on them.

A worked example of "before adding to your contract, ask which existing primitive can carry the signal." `Error` couldn't. A class hierarchy could. Ten lines.
