# @rotorsoft/act-patch

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act-patch.svg)](https://www.npmjs.com/package/@rotorsoft/act-patch)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act-patch.svg)](https://www.npmjs.com/package/@rotorsoft/act-patch)
[![Build Status](https://github.com/rotorsoft/act-root/actions/workflows/ci-cd.yml/badge.svg?branch=master)](https://github.com/rotorsoft/act-root/actions/workflows/ci-cd.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Immutable deep-merge patch utility for [Act](https://github.com/rotorsoft/act-root) event-sourced apps. Zero dependencies, browser-safe.

## Install

```sh
npm install @rotorsoft/act-patch
# or
pnpm add @rotorsoft/act-patch
```

## API

### `patch(original, patches) → state`

Immutably deep-merges `patches` into `original`, returning a new state object.

```typescript
import { patch } from "@rotorsoft/act-patch";

const state = { user: { name: "Alice", age: 30 }, theme: "dark" };
const updated = patch(state, { user: { age: 31 } });
// → { user: { name: "Alice", age: 31 }, theme: "dark" }
```

#### Merging Rules

| Value type | Behavior |
|---|---|
| Plain objects | Deep merge recursively |
| Arrays, Dates, RegExp, Maps, Sets, TypedArrays | Replace entirely |
| `undefined` or `null` | Delete the property |
| Primitives (string, number, boolean) | Replace with patch value |

```typescript
// Deep merge nested objects
patch({ a: { x: 1, y: 2 } }, { a: { x: 10 } })
// → { a: { x: 10, y: 2 } }

// Replace arrays (not merged)
patch({ items: [1, 2, 3] }, { items: [4, 5] })
// → { items: [4, 5] }

// Delete properties
patch({ a: 1, b: 2, c: 3 }, { b: undefined, c: null })
// → { a: 1 }

// Add new keys
patch({ a: 1 }, { b: 2 })
// → { a: 1, b: 2 }
```

#### Purity and Structural Sharing

`patch()` is a **pure function** — it never mutates its arguments and always returns a deterministic result for the same inputs.

Unpatched subtrees are **reused by reference** (structural sharing), not deep-copied. This is the same approach used by Immer, Redux Toolkit, and other immutable state libraries.

```typescript
const original = { unchanged: { deep: true }, patched: "old" };
const result = patch(original, { patched: "new" });

result.unchanged === original.unchanged  // true — same reference
result !== original                      // true — new top-level object
```

This is safe in Act's event sourcing model because:

- State is always typed as `Readonly<S>` — the type system prevents mutation
- Events are immutable — state is only ever updated through new patches
- Each `patch()` call creates a new top-level object; unchanged subtrees are shared, not copied

An empty patch short-circuits entirely and returns the original reference with zero allocation:

```typescript
const result = patch(state, {});
result === state  // true — no work done
```

### Types

```typescript
import type { Patch, DeepPartial, Schema } from "@rotorsoft/act-patch";

// Schema — plain object shape
type Schema = Record<string, any>;

// Patch<T> — recursive partial for patching state
type Patch<T> = {
  [K in keyof T]?: T[K] extends Schema ? Patch<T[K]> : T[K];
};

// DeepPartial<T> — recursive deep partial (alias for consumer APIs)
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, any> ? DeepPartial<T[K]> : T[K];
};
```

## Comparison: Act Patch vs JSON Patch (RFC 6902) vs JSON Merge Patch (RFC 7396)

### JSON Patch (RFC 6902)

An **array of operations** (`add`, `remove`, `replace`, `move`, `copy`, `test`) with JSON Pointer paths.

```json
[
  { "op": "replace", "path": "/user/name", "value": "Alice" },
  { "op": "remove", "path": "/temp" },
  { "op": "add", "path": "/items/-", "value": 42 }
]
```

**Pros:** Standardized, array-index-level operations, conditional `test` ops, compact for sparse changes, `move`/`copy` without data duplication.

**Cons:** Verbose for bulk updates (each field = separate operation), path parsing overhead, requires diff algorithm to produce patches, index-based array ops fragile under concurrency, not type-safe (paths are strings), ~5 KB+ library overhead.

### JSON Merge Patch (RFC 7396)

A **partial document** recursively merged into the target. Closest to Act's approach.

```json
{ "user": { "name": "Alice" }, "temp": null }
```

**Pros:** Simple mental model, compact for bulk updates, standardized.

**Cons:** Cannot set a value to `null` (null means delete), cannot express array-element-level changes, no conditional operations.

### Why Act's Approach Wins for Event Sourcing

| Criterion | JSON Patch (6902) | Merge Patch (7396) | Act Patch |
|---|---|---|---|
| Type safety | None (paths are strings) | Partial (shape matches) | **Full** (Zod + `Patch<T>`) |
| Bundle size | ~5 KB+ | Trivial | **< 1 KB** |
| Apply perf | O(ops x path parse) | O(keys x depth) | **O(keys x depth)** |
| Delete semantics | Explicit `remove` op | `null` = delete | `null`/`undefined` = delete |
| Array handling | Index ops (fragile) | Replace only | Replace only (correct for ES) |
| Event sourcing fit | Poor (opaque ops) | Good | **Best** (patch = event data shape) |

**Key insight:** In event sourcing, each event's data *is* the patch. The event schema (Zod) already constrains the shape, providing compile-time and runtime validation for free. JSON Patch would add an unnecessary indirection layer — event data translated into operations, losing type safety and adding overhead.

## Optimizations

1. **Short-circuit on empty patch** — returns the original reference with zero allocation.
2. **Fast-path for primitives** — skips mergeability when `typeof value !== "object"`.
3. **Structural sharing** — unpatched subtrees are reused by reference instead of deep-copied.
4. **Hybrid copy strategy** — uses V8-optimized spread for small objects (≤16 keys) and prototype-free two-pass enumeration for larger ones, avoiding spread overhead on wide states.
5. **O(1) mergeability** — single `constructor === Object` check instead of iterating types.

## Benchmarks

Run with `npx vitest bench libs/act-patch/test/patch.bench.ts`.

### Act Patch vs JSON Patch (RFC 6902) vs JSON Merge Patch (RFC 7396)

All three implementations tested with equivalent operations on the same fixtures. JSON Patch and Merge Patch are inline reference implementations following their respective specs. Results on Apple M4 Max, Node 22:

| Benchmark | Act Patch | Merge Patch (7396) | JSON Patch (6902) |
|---|---:|---:|---:|
| no-op (empty) | **21.5M** ops/s | 12.5M ops/s | 2.4M ops/s |
| shallow single-key (5 keys) | 16.3M ops/s | **23.4M** ops/s | 2.2M ops/s |
| deep 3-level | **3.0M** ops/s | 2.6M ops/s | 957K ops/s |
| delete | 4.6M ops/s | **5.1M** ops/s | 1.7M ops/s |
| array replacement | **13.0M** ops/s | 12.8M ops/s | 2.9M ops/s |
| sequential 10 patches | 1.1M ops/s | **1.4M** ops/s | 237K ops/s |
| wide object (100 keys) | **221K** ops/s | 61K ops/s | 159K ops/s |
| large state (1000 keys, 10-key) | **20.9K** ops/s | 4.0K ops/s | 7.4K ops/s |

**Takeaway:** Act Patch matches or beats Merge Patch on small objects and dominates on wide/large states (3.5–5.2x faster) thanks to structural sharing and the hybrid copy strategy. JSON Patch is consistently the slowest due to deep-clone + path parsing overhead.

## Browser Support

- Zero Node.js dependencies
- No `process`, `Buffer`, or other Node globals
- Dual CJS/ESM output, fully tree-shakeable (`sideEffects: false`)

## License

MIT
