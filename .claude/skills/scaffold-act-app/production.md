# Production Deployment

Covers production-specific concerns beyond what's in [monorepo-template.md](monorepo-template.md). The template already provides `scheduleDrain()`, `eventBus`, auth crypto, `createContext()`, and dev seed scripts.

## Switch to PostgreSQL

```typescript
import { store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

store(new PostgresStore({
  host: process.env.PG_HOST ?? "localhost",
  port: Number(process.env.PG_PORT ?? 5432),
  database: process.env.PG_DATABASE ?? "myapp",
  user: process.env.PG_USER ?? "postgres",
  password: process.env.PG_PASSWORD ?? "secret",
  schema: "public",
  table: "events",
}));
```

Install: `pnpm -F @my-app/app add @rotorsoft/act-pg`

## Background Correlation (Large-Scale)

For high-throughput deployments, use periodic background correlation instead of (or in addition to) the debounced `scheduleDrain()` from helpers.ts:

```typescript
// Periodic correlation resolution — discovers new reaction streams every 3s
const stop = app.start_correlations({ after: 0, limit: 10 }, 3000);

// Graceful shutdown
process.on("SIGTERM", () => {
  stop();
  store().dispose();
});
```

## Automated Jobs

Query projected read models and dispatch actions on schedules:

```typescript
import { systemActor } from "@my-app/domain";

async function autoClose(batchSize: number) {
  const stale = await db.select()
    .from(items)
    .where(lt(items.closeAfter, Date.now()))
    .limit(batchSize);

  for (const item of stale) {
    await app.do("CloseItem", { stream: item.id, actor: systemActor }, {})
      .catch(console.error);
  }
}

setInterval(() => autoClose(10), 15_000);
```

## Error Handling in Production

```typescript
import { Errors } from "@rotorsoft/act";

try {
  await app.do("CreateItem", target, payload);
} catch (error) {
  if (error.message === Errors.ValidationError) { /* bad input */ }
  if (error.message === Errors.InvariantError) { /* rule violated */ }
  if (error.message === Errors.ConcurrencyError) { /* retry */ }
}
```

Error constants: `Errors.ValidationError = "ERR_VALIDATION"`, `Errors.InvariantError = "ERR_INVARIANT"`, `Errors.ConcurrencyError = "ERR_CONCURRENCY"`.

## Drain Options

```typescript
await app.drain({
  streamLimit: 100,   // Max streams to fetch per cycle
  eventLimit: 1000,   // Max events per stream
  leaseMillis: 10000, // Lease duration in ms
});
```

## Observability

```typescript
// Observe all state changes
app.on("committed", (snapshots) => { /* log, metrics */ });

// Catch reaction failures
app.on("blocked", (leases) => { /* alert on blocked streams */ });

// Query events directly
const events = await app.query_array({ stream: "my-stream" });
```

Set `LOG_LEVEL=debug` or `LOG_LEVEL=trace` for verbose framework logging (uses pino).

## Seed Data for Development

See `dev-server.ts` in [monorepo-template.md](monorepo-template.md) for the complete seed pattern. Key points:
- Use `systemActor` for seed actions
- Call `correlate()` + `drain()` in a loop after seeding to process all reactions and projections
- Seed an admin user with `hashPassword()` for development access
