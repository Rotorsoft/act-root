# ACT-1119 — the math that shouldn't be an export

## What this ticket closes — and what it almost shipped instead

[ACT-1118](./act-1118-idempotency-store.md) shipped the dedup contract: `IdempotencyStore.claim` and a reference in-memory implementation. The companion question — *how big should the dedup window be?* — was a section of doc prose in [external integration](../docs/docs/guides/external-integration.md), worked through as a per-attempt table for one specific backoff strategy. Every operator wiring up a receiver was expected to do the math themselves, often miscompute it, and ship a window too short to outlast the sender's actual retry envelope. The failure mode is silent — duplicate side effects in the data, no error log — so the bug rarely got reported back. ACT-1119's job is to make that miscount impossible.

The first draft of the fix was a freestanding helper: `computeMinSafeTtl(reaction): number`, exported from `@rotorsoft/act-ops`. Same math, same parameters, but as a public function that operators would call at bootstrap and pass the result into `InMemoryIdempotencyStore({ ttlMs })`. The ticket spec called it out by name. The first PR draft implemented it that way and even shipped its own `BackoffOptions` type structurally mirroring the framework's.

That draft is not what landed. The interesting part of this ticket is the conversation that killed it.

## The argument against exporting the helper

A function is the right shape for math. A function is the wrong shape for *this* math, because nothing about the operation justifies the surface area:

1. **It composes with exactly one consumer.** `computeMinSafeTtl(profile)` produces a number whose only legitimate destination is `InMemoryIdempotencyStore({ ttlMs })`. Library exports that thread through a single other library export are smell — they're suggesting the wrong factoring.

2. **The math runs once at bootstrap.** It's not a hot path, not a method on a long-lived object, not a primitive that gets called repeatedly. A bootstrap-time computation that produces a constant for the lifetime of the process doesn't need to be its own API.

3. **The recommendation is "use 24h regardless."** The doc explicitly says most apps land at 24h and the math is there to *verify* 24h is generous, not to argue against it. A function that returns a number operators are going to ignore is documentation cosplay.

4. **It upholds no contract.** Unlike `IdempotencyStore` (a port that durable adapters implement) or `InMemoryIdempotencyStore` (an implementation of that port), `computeMinSafeTtl` is just a calculation. There's no spec for what makes a "valid" implementation — there's just the one correct formula. That's a strong tell the calculation should live inside the consumer, not as a top-level export.

5. **It encourages a precedent we don't want.** `@rotorsoft/act-ops` is positioned as the home for *operational primitives* — ports, contracts, reference impls. The moment we ship a freestanding math helper, the gate against shipping every other freestanding math helper (jitter probability calculators, lease-window estimators, backoff-budget classifiers) drops. The package's shape should resist that drift.

The user's intuition cut through it in one question: *why not pass more options to the store and calculate this safe TTL internally?*

That's the right factoring. The math goes where it's actually used. The function disappears from the public surface. The operator's mental model collapses to "configure the store" instead of "call this helper, then configure the store with its result."

## What landed

`InMemoryIdempotencyStoreOptions` gains a `retryProfile` field alongside the existing `ttlMs`:

```ts
type InMemoryIdempotencyStoreOptions = {
  ttlMs?: number;
  retryProfile?: RetryProfile;
  maxEntries?: number;
};
```

The store's constructor resolves the window in priority order: `ttlMs` if provided, otherwise derive from `retryProfile` if provided, otherwise the 24-hour default. When both are supplied, `ttlMs` wins — explicit beats derived, which is the right default for the awkward case where someone passes both by mistake.

The math itself moved to `libs/act-ops/src/idempotency/min-safe-ttl.ts` as an internal function. It's `export`ed at the module level (so tests can import it directly via `../src/idempotency/min-safe-ttl.js`), but not re-exported from `libs/act-ops/src/index.ts`. The package's `exports` map only exposes `.`, so external consumers can only see what `index.ts` re-exports. The math is reachable from within the package's test tree and invisible from outside. That's the cleanest privacy mechanism TypeScript packages have — no special test-subpath, no internal-marker convention, just an unreferenced module.

When `PostgresIdempotencyStore` and `RedisIdempotencyStore` land in milestone 1.2, both accept the same `retryProfile` option and call the same `minSafeTtl(profile)` — the math gets lifted to `internal/min-safe-ttl.ts` then, with both adapters importing it from there. No code change in the function itself; just a file move. Single source of truth, zero exposed surface.

## The `RetryProfile` type, and why it's the only new export

The math takes four pieces of information: how many retries, what backoff shape, what per-attempt timeout, what safety factor. That's a small enough record to inline at every call site, but it's repeated often enough (every receiver that uses the derivation, every test, every doc example) that giving it a name pays off. `RetryProfile` describes the sender's behaviour in a single type. It's new vocabulary — the framework doesn't have it — so exporting it doesn't conflict with anything in `@rotorsoft/act`.

The `backoff` field inside `RetryProfile` is a different story. The framework already ships `BackoffOptions` with exactly the shape we'd want — `{ strategy, baseMs, maxMs?, jitter? }`. The first draft of this ticket re-declared it under the same name in act-ops, structurally identical, justified by the zero-act-dep constraint ("we can't import from act, so we have to re-declare"). That logic was wrong. The constraint prohibits *importing*, not *defining the same shape*. But defining a separate `BackoffOptions` is *reinventing*, which is what we were trying to avoid by aligning vocabulary with the framework in the first place.

The fix was structural: type the `backoff` field inline inside `RetryProfile`, anonymous. TypeScript's structural typing handles the rest — a caller holding a value typed as `act.BackoffOptions` can pass it as `RetryProfile["backoff"]` with no cast, because the two structures match. The framework's name stays the canonical one; act-ops doesn't compete with it. No imports, no duplications, no parallel names.

The lesson is small but worth repeating: when a sibling package needs a type that already exists in the canonical home, prefer structural anonymity over named duplication. The compiler accepts the assignment either way; the package surface stays uncluttered; future readers don't have to wonder "why are there two `BackoffOptions` types and which one am I supposed to use." None and yours-inline-where-it-matters, respectively, is the answer.

## What this teaches about act-ops's shape

`@rotorsoft/act-ops` is now two PRs in (`#828` bootstrapped the package, `#832` shipped the port + reference impl) and the shape is settling into something coherent. The package exports:

- a port (`IdempotencyStore`)
- a reference implementation (`InMemoryIdempotencyStore`)
- the implementation's options type (`InMemoryIdempotencyStoreOptions`)
- one supporting domain type (`RetryProfile`)

It does *not* export:

- the math that the implementation uses internally
- a freestanding TTL helper
- a parallel `BackoffOptions` to the framework's
- a parallel `safetyFactor` constant

The pattern emerging is: ports define contracts, implementations implement them, domain types are exposed only when they appear in public signatures. Math and helpers stay private to the implementation that consumes them. When a sibling implementation lands (Postgres, Redis), the shared math gets extracted into a non-exported internal module — same API surface, same compute, more implementations.

That's a healthier shape than the first draft suggested. The first draft was treating act-ops as a grab-bag of operational helpers, and the temptation to add "one more useful function" never ends in a grab bag. The second draft — which the user's question forced — treats it as a contract package. The contract package's surface is much smaller than the grab bag's, and the work is in maintaining the contracts honestly. That's the work we actually want to be doing.

The next ticket in the sequence is [ACT-1116](https://github.com/Rotorsoft/act-root/issues/744), the framework-agnostic idempotency middleware. It consumes `IdempotencyStore` and lives in `@rotorsoft/act-http/receiver`. Per the same principle: the middleware is contract-shaped, the per-framework adapters are tiny, no orphan helpers. The trajectory holds.
