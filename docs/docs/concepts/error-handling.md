---
id: error-handling
title: Error Handling
---

# Error Handling

Act defines three primary error types. Each signals a different class of problem with a distinct resolution strategy.

## ValidationError

Thrown when an action or event payload fails Zod schema validation.

```typescript
import { ValidationError } from "@rotorsoft/act";

try {
  await app.do("createUser", target, { email: 123 }); // wrong type
} catch (error) {
  if (error instanceof ValidationError) {
    console.error("Invalid payload:", error.details);
  }
}
```

**Resolution:** Fix the payload to match the schema. This is always a caller error.

## InvariantError

Thrown when a business rule defined via `.given()` is violated before events are emitted.

```typescript
import { InvariantError } from "@rotorsoft/act";

try {
  await app.do("CloseTicket", target, { reason: "Done" });
} catch (error) {
  if (error instanceof InvariantError) {
    console.error("Rule violated:", error.description);
    console.error("Current state:", error.snapshot.state);
  }
}
```

**Resolution:** Check preconditions before dispatching, or handle gracefully in the UI. The state was not modified.

## ConcurrencyError

Thrown when optimistic concurrency control detects a conflict — another process committed events to the same stream between your `load()` and `commit()`.

```typescript
import { ConcurrencyError } from "@rotorsoft/act";

try {
  await app.do("increment", target, { by: 1 });
} catch (error) {
  if (error instanceof ConcurrencyError) {
    console.error(`Stream ${error.stream}: expected v${error.expectedVersion}, found v${error.version}`);
  }
}
```

**Resolution:** Retry with fresh state. The cache is invalidated automatically on concurrency errors.

### Retry Pattern

```typescript
async function withRetry(action, target, payload, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await app.do(action, target, payload);
    } catch (error) {
      if (error instanceof ConcurrencyError && attempt < maxRetries) {
        continue; // cache was invalidated, next load() gets fresh state
      }
      throw error;
    }
  }
}
```

## Error Constants

For string-based error matching (e.g., in tRPC error handlers):

```typescript
import { Errors } from "@rotorsoft/act";

// Errors.ValidationError  = "ERR_VALIDATION"
// Errors.InvariantError   = "ERR_INVARIANT"
// Errors.ConcurrencyError = "ERR_CONCURRENCY"
```

## Production Error Handling

```typescript
import { Errors } from "@rotorsoft/act";

// tRPC mutation
CreateItem: authedProcedure
  .input(z.object({ name: z.string() }))
  .mutation(async ({ input, ctx }) => {
    try {
      const snaps = await app.do("CreateItem", { stream: id, actor: ctx.actor }, input);
      app.settle();
      return { success: true, id };
    } catch (error) {
      if (error.message === Errors.ValidationError) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid input" });
      }
      if (error.message === Errors.InvariantError) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.description });
      }
      if (error.message === Errors.ConcurrencyError) {
        throw new TRPCError({ code: "CONFLICT", message: "Please retry" });
      }
      throw error;
    }
  }),
```

## Blocked Streams

When a reaction handler fails repeatedly, the stream is blocked after exceeding `maxRetries` (default: 3). Blocked streams are excluded from `poll()` and won't be processed until manually unblocked.

Monitor blocked streams via the `"blocked"` lifecycle event:

```typescript
app.on("blocked", (blocked) => {
  blocked.forEach(({ stream, error, retry }) => {
    console.error(`Stream ${stream} blocked after ${retry} retries: ${error}`);
    // Alert, log to monitoring, etc.
  });
});
```

Reaction options can be configured per handler:

```typescript
.on("OrderPlaced")
  .do(handler, { maxRetries: 5, blockOnError: true })
  .to(resolver)
```
