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

### `is_mergeable(value) → boolean`

Returns `true` if the value is a plain object eligible for deep merging. Returns `false` for primitives, `null`, `undefined`, and all unmergeable types (Array, Date, Map, Set, RegExp, TypedArrays, etc.).

```typescript
import { is_mergeable } from "@rotorsoft/act-patch";

is_mergeable({ a: 1 })       // true
is_mergeable([1, 2])         // false
is_mergeable(new Date())     // false
is_mergeable(new Map())      // false
is_mergeable(null)           // false
is_mergeable(42)             // false
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

The implementation applies several optimizations over a naive deep-merge:

1. **Short-circuit on empty patch** — returns the original reference with zero allocation.
2. **Fast-path for primitives** — skips the `is_mergeable` check entirely when `typeof value !== "object"`.
3. **Structural sharing** — unpatched subtrees are reused by reference instead of deep-copied.
4. **Two-pass key enumeration** — iterates original keys then patch keys separately, avoiding the temporary `{ ...original, ...patches }` spread allocation.
5. **Prototype-free result** — uses `Object.create(null)` to avoid prototype-chain lookups on the result object.

## Benchmarks

Run with `npx vitest bench libs/act-patch/test/patch.bench.ts`.

Results on Apple M4 Max, Node 22:

| Benchmark | ops/sec | mean |
|---|---:|---:|
| no-op (empty patch) | 21,837,400 | 0.00005 ms |
| shallow single-key (5 keys) | 5,260,956 | 0.0002 ms |
| delete via null | 5,361,732 | 0.0002 ms |
| delete via undefined | 5,326,153 | 0.0002 ms |
| array replacement | 7,673,664 | 0.0001 ms |
| deep 3-level patch | 873,932 | 0.0011 ms |
| wide object (100 keys) | 210,187 | 0.0048 ms |
| sequential 10 patches | 453,442 | 0.0022 ms |
| large state (1000 keys, 10-key patch) | 20,034 | 0.0499 ms |

## Browser Support

- Zero Node.js dependencies
- SharedArrayBuffer guard for environments where it's unavailable
- No `process`, `Buffer`, or other Node globals
- Dual CJS/ESM output, fully tree-shakeable (`sideEffects: false`)
- Compatible with Chrome 90+, Firefox 90+, Safari 15+

## License

MIT
