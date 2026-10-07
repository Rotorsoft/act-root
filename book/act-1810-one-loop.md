# ACT-1810: One loop for the in-memory query

## The pain that started it

`InMemoryStore.query` was the most complex function in the repository by the linter's count, and one of the most edited. It walked the event array twice over: one loop for forward reads and a near copy for backward reads. Each loop carried its own idea of where to start and where to stop, and every new filter had to be added to both, in the right order relative to the `break` and `continue` lines. That order mattered, because some bounds end a scan and others only skip an event, and a bound added to the wrong side of that line in only one loop would make the reference adapter disagree with Postgres in one direction only.

## Why the obvious answer didn't fit

The natural first move was to pull the shared filters into a helper and leave the two loops in place. That would have shortened the function without removing the reason it kept breaking: two loops that each decide independently when to stop.

## The decision

The bounds that end a scan are all id bounds: `after`, `before`, and the snapshot floor that `with_snaps` resumes from. Because the log is ordered by id, those three collapse into a single index window, `[lo, hi)`, found with the binary search the store already had. Everything else, including the `created` bounds that never end a scan because restored events keep their original timestamps, is a per-event filter. A single loop walks the window from either end:

```ts
for (let k = 0; k < hi - lo; k++) {
  const e = this._events[query?.backward ? hi - 1 - k : lo + k];
  if (query && !this.in_query(query, e)) continue;
  ...
}
```

The same pull request moved the drain, reaction and settle defaults out of the call sites (`?? 10`, `?? 3`, `?? true`) into `internal/config.ts`. The shutdown grace default is now defined as the drain lease rather than a second copy of the same number.

## What this teaches

When two branches differ only in direction, look for the quantity they share. Here it was an index window; once the stopping rules were written as a window, the direction became a single expression and the filters had one place to live. The store TCK's query matrix, which runs every combination against the in-memory store, is what made the rewrite safe to do in one step.

## Connections to other chapters

The store contract this adapter is the reference for is in `docs/docs/architecture/extension-points.md`; the config home is described in CLAUDE.md under "Config-validation schemas".
