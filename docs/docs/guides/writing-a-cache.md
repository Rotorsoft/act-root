---
id: writing-a-cache
title: Writing a custom Cache adapter
---

# Writing a custom Cache adapter

`Cache` is the snapshot-cache port — it sits in front of state loading so hot streams skip rehydrating from the event log on every action. The framework ships a process-local `InMemoryCache` (LRU). Anything else — Redis, Memcached, Valkey, a distributed cache fronted by your own service — is a custom adapter.

## The contract

The interface in [`libs/act/src/types/ports.ts`](https://github.com/Rotorsoft/act-root/blob/master/libs/act/src/types/ports.ts) is small:

```ts no-check
interface Cache extends Disposable {
  get<TState>(stream: string): Promise<CacheEntry<TState> | undefined>;
  set<TState>(stream: string, entry: CacheEntry<TState>): Promise<void>;
  invalidate(stream: string): Promise<void>;
  clear(): Promise<void>;
}
```

Four methods plus `dispose`. The async signature is forward-compatible with external caches like Redis.

## The TCK is the spec

```ts no-check
// libs/act-redis/test/cache-tck.spec.ts
import { runCacheTck } from "@rotorsoft/act-tck";
import { RedisCache } from "../src/index.js";

runCacheTck({
  name: "RedisCache",
  factory: () => new RedisCache({ url: process.env.REDIS_URL! }),
});
```

The TCK exercises:

- `get` on an unset stream returns `undefined`
- `set` then `get` round-trips an entry
- `set` overwrites a prior entry on the same stream
- `invalidate` removes one stream and leaves others
- `invalidate` / `clear` are no-ops on absent state
- `clear` empties every stream
- Entries are isolated per stream
- `dispose` is idempotent

Adapter-specific behavior — LRU ordering, TTL, size limits, network reconnect — stays in your adapter's own test suite. The TCK only asserts what every Cache must honor.

## Scaffolding `@rotorsoft/act-redis` (sketch)

```
libs/act-redis/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── tsup.config.ts
├── src/
│   ├── index.ts
│   └── redis-cache.ts        # implements Cache
├── test/
│   ├── cache-tck.spec.ts     # runCacheTck({ factory: () => new RedisCache(…) })
│   └── ttl.spec.ts           # adapter-specific TTL semantics
└── README.md
```

The README's testing section:

````md
## Testing

```ts no-check
import { runCacheTck } from "@rotorsoft/act-tck";
import { RedisCache } from "@rotorsoft/act-redis";

runCacheTck({
  name: "RedisCache",
  factory: () => new RedisCache({ url: process.env.REDIS_URL! }),
});
```
````

## When the Cache port changes

If the framework extends the Cache interface (a TTL primitive, a multi-get for batched rehydration, etc.), the corresponding cases land in `libs/act-tck/src/cache-tck.ts`. New optional methods are gated behind a `Capabilities` flag so existing adapters keep passing until they opt in.

## Cross-references

- Contract: [`libs/act/src/types/ports.ts`](https://github.com/Rotorsoft/act-root/blob/master/libs/act/src/types/ports.ts)
- Reference implementation: [`InMemoryCache`](https://github.com/Rotorsoft/act-root/blob/master/libs/act/src/adapters/in-memory-cache.ts)
- TCK source: [`libs/act-tck/src/cache-tck.ts`](https://github.com/Rotorsoft/act-root/blob/master/libs/act-tck/src/cache-tck.ts)
- Architecture: [cache-and-snapshots.md](../architecture/cache-and-snapshots.md)
