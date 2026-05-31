# @rotorsoft/act-patch

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act-patch.svg)](https://www.npmjs.com/package/@rotorsoft/act-patch)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act-patch.svg)](https://www.npmjs.com/package/@rotorsoft/act-patch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

_Immutable deep-merge patch utility for event-sourced apps. Zero dependencies, browser-safe, sub-microsecond on small states._

## Why this package

Event sourcing reduces every state mutation to applying a patch on top of a prior state. Doing that well requires three properties at once: type safety (so the compiler enforces the patch shape against the state shape), immutability (so reducers can't accidentally mutate snapshots), and structural sharing (so unchanged subtrees don't get deep-copied on every event). Most existing solutions get one or two; `act-patch` gets all three.

`patch(original, patches)` is the forward direction — the reducer that the Act framework applies on every committed event. Its input type `Patch<S>` is operator-facing: `null` and `undefined` are deletion sentinels. `delta(before, after)` is the inverse for the equal-shape case — it computes the smallest `DeepPartial<S>` describing what *changed*, suitable for use as event data. Events record positive facts, so `delta`'s output never carries the deletion sentinel; round-trip identity holds when `before` and `after` share the same key set. Use `patch(state, { key: null })` directly when you need to express deletion as an instruction. Zod schemas handle validation; this package handles the algebra.

Used internally by `@rotorsoft/act` state reducers and `@rotorsoft/act-http/sse` for incremental state broadcast. Equally useful standalone in any TypeScript app that needs immutable deep-merge.

## Installation

```bash
pnpm add @rotorsoft/act-patch
```

## Quick start

```ts
import { patch, delta } from "@rotorsoft/act-patch";

const state = { user: { name: "Alice", age: 30 }, theme: "dark" };

// Forward: apply a patch (immutably)
const updated = patch(state, { user: { age: 31 } });
// → { user: { name: "Alice", age: 31 }, theme: "dark" }

// Inverse: compute the patch that produces `after` from `before`
const d = delta(state, updated);
// → { user: { age: 31 } }

patch(state, d);
// → updated (deeply equal)
```

That's the whole surface — two functions plus the type-level helpers. Everything below is rules, performance characteristics, and the comparison to the standardized alternatives.

## API

- **`patch(original, patches)`** — immutably deep-merges `patches` into `original`. Returns a new state object with structural sharing of unchanged subtrees. Accepts `Patch<S>` (positive changes plus `null`/`undefined` deletion sentinels).
- **`delta(before, after)`** — computes the smallest `DeepPartial<S>` describing what changed from `before` to `after`. Designed for event payloads — never *synthesizes* `null` for a missing key, but always *propagates* `null` when the caller put one in `after`. See [Modeling deletions](#modeling-deletions) for how that asymmetry carries a clear-this-field action all the way to the aggregate.
- **Types**: `Patch<T>` (operator-facing recursive partial with `null` deletion), `DeepPartial<T>` (event-payload shape returned by `delta`, includes `null` only where the schema declares `T[K]` as nullable), `Schema` (plain-object shape).

## Modeling deletions

The end-to-end deletion flow — action signals "clear this field" → event records it → reducer applies it to state — works through `delta` without you having to switch tools. The rule is short: **`delta` never invents a `null`, but it forwards every `null` the caller put in `after`.** That means the *action* drives the runtime, and the *schema* controls the type:

| What the caller put in `after` for key `k` | What `delta` returns for `k` | What `patch` does on replay |
|---|---|---|
| (key omitted)                              | (key omitted)                | leaves `state[k]` alone |
| explicit `null` (schema permits)           | `null`                       | deletes `state[k]` (null is `patch`'s deletion sentinel) |
| new value                                  | the new value                | sets `state[k]` |
| same reference as `before[k]`              | (key omitted)                | leaves `state[k]` alone |

```ts
// 1) Action with a deletable field — schema declares it `.nullable()`
const state = { bio: "old", name: "Alice" };
const data  = { bio: null, name: "Alice" };

const eventPayload = delta(state, data);
// → { bio: null }      ← propagated, not synthesized

patch(state, eventPayload);
// → { name: "Alice" }  ← state.bio is gone

// 2) Action that just doesn't touch a field — non-nullable schema is fine
const data2 = { name: "Bob" };  // no `bio` key at all
const eventPayload2 = delta(state, data2);
// → { name: "Bob" }    ← bio is omitted because the action didn't mention it

patch(state, eventPayload2);
// → { bio: "old", name: "Bob" }  ← bio left alone
```

The asymmetry is what keeps the konsult-style scenario clean: a schema with no `.nullable()` fields produces a `DeepPartial<S>` with no `| null` arms, an action that conforms to that schema can't carry `null`, and `delta` can't put one in the output because there was nothing in `after` to propagate. The type and the runtime agree: no nulls anywhere. As soon as a schema opts into `.nullable()` on a field, the type widens to admit `null`, the action can carry it, and `delta` carries it through. Same code path, both behaviors, driven by the schema.

## Common patterns

### Merging rules

| Value type | `patch` behavior |
|---|---|
| Plain objects | Deep merge recursively |
| Arrays, Dates, RegExp, Maps, Sets, TypedArrays | Replace entirely |
| `undefined` or `null` | Delete the property |
| Primitives (string, number, boolean) | Replace with patch value |

```ts
patch({ a: { x: 1, y: 2 } }, { a: { x: 10 } });          // → { a: { x: 10, y: 2 } }
patch({ items: [1, 2, 3] }, { items: [4, 5] });          // → { items: [4, 5] }
patch({ a: 1, b: 2, c: 3 }, { b: undefined, c: null });  // → { a: 1 }
patch({ a: 1 }, { b: 2 });                                // → { a: 1, b: 2 }
```

### Structural sharing

`patch` is a pure function — it never mutates inputs. Unpatched subtrees are reused by reference (same approach as Immer, Redux Toolkit). An empty patch short-circuits entirely:

```ts
const original = { unchanged: { deep: true }, patched: "old" };
const result = patch(original, { patched: "new" });

result.unchanged === original.unchanged;  // true — same reference
result !== original;                      // true — new top-level object

patch(state, {}) === state;                // true — no work, no allocation
```

This is safe in event sourcing because state is typed `Readonly<S>` (compiler prevents mutation), events are immutable (state is only updated through new patches), and each `patch()` call creates a new top-level object.

### Round-trip identity

```
patch(before, delta(before, after))  ≡  after
   // when keys(after) ⊇ keys(before),  OR
   // when every key in before \ after is set to null in after

delta(before, before)                ≡  {}           // idempotent
```

The round-trip holds whenever `after` faithfully expresses the intended end-state — either by retaining every original key (the equal-shape case, common for event payloads against a stable state schema) or by setting the to-be-removed keys to `null` (the caller-driven deletion case from [Modeling deletions](#modeling-deletions)). If `after` silently *omits* a key that was in `before`, `delta` reads that as "no change" and the dropped key survives the replay — express the deletion as `null` instead, or instruct `patch` directly (`patch(before, { key: null })`).

In Act's event sourcing model, an event's data *is* the (event-shaped) patch. Either direction works: emit `delta(prev, next)` as event data and let the framework apply it via `patch`, or hand-write a `Patch<S>` and emit it directly. No diff/merge logic on the application side.

### Equality semantics in `delta`

`delta` mirrors `patch`'s structural-sharing model — equality is reference-based (`Object.is`), not deep:

| Case | Behavior |
|---|---|
| Same reference (`Object.is`) | omit (mirrors patch's structural sharing) |
| Both plain objects | recurse |
| Different references, any other diff | set to `after[K]` (wholesale replace) |
| Key in `before` only — *omitted* from `after` | omit (no synthesized null at any depth) |
| Key in `after` set explicitly to `null` | set to `null` (caller-driven deletion — propagated, see [Modeling deletions](#modeling-deletions)) |
| Key in `after` only (introduced) | set to `after[K]` |

Two structurally-equal-but-distinct values (e.g. two `Date` instances with the same `getTime()`) emit a replacement — safe semantically, just slightly less compact. `Object.is` handles `NaN === NaN` and distinguishes `+0` from `-0` correctly.

## When to use this vs JSON Patch (RFC 6902) vs JSON Merge Patch (RFC 7396)

| Criterion | JSON Patch (RFC 6902) | Merge Patch (RFC 7396) | `act-patch` |
|---|---|---|---|
| Type safety | None (paths are strings) | Partial (shape matches) | **Full** (`Patch<T>` derived from `T`) |
| Bundle size | ~5 KB+ | trivial | **< 1 KB** |
| Apply perf | O(ops × path parse) | O(keys × depth) | **O(keys × depth)** with structural sharing |
| Delete semantics | Explicit `remove` op | `null` = delete | `null`/`undefined` = delete |
| Array handling | Index ops (fragile under concurrency) | Replace only | Replace only |
| Event sourcing fit | Poor (opaque ops) | Good | **Best** (patch ≡ event data shape) |

**Pick this** when you want type-safe patches over a Zod-derived schema. **Pick Merge Patch** when you need a standardized wire format with simple semantics and don't care about type safety. **Pick JSON Patch** when you genuinely need atomic array-index-level operations or conditional `test` ops — rare outside collaborative editing.

## Benchmarks

Run with `pnpm bench:micro libs/act-patch/bench/patch.micro.bench.ts`. Inline reference implementations of RFC 6902 and 7396 are tested with equivalent operations on the same fixtures. Apple M4 Max, Node 22:

| Benchmark | Act Patch | Merge Patch (7396) | JSON Patch (6902) |
|---|---:|---:|---:|
| no-op (empty) | **21.5M** ops/s | 12.5M ops/s | 2.4M ops/s |
| shallow single-key (5 keys) | 16.3M ops/s | **23.4M** ops/s | 2.2M ops/s |
| deep 3-level | **3.0M** ops/s | 2.6M ops/s | 957K ops/s |
| delete | 4.6M ops/s | **5.1M** ops/s | 1.7M ops/s |
| array replacement | **13.0M** ops/s | 12.8M ops/s | 2.9M ops/s |
| sequential 10 patches | 1.1M ops/s | **1.4M** ops/s | 237K ops/s |
| wide object (100 keys) | **221K** ops/s | 61K ops/s | 159K ops/s |
| large state (1000 keys, 10-key patch) | **20.9K** ops/s | 4.0K ops/s | 7.4K ops/s |

Act Patch matches or beats Merge Patch on small objects and dominates on wide/large states (3.5–5.2× faster) thanks to structural sharing and a hybrid copy strategy (V8-optimized spread for small objects, prototype-free two-pass enumeration for larger ones). JSON Patch is consistently the slowest due to deep-clone + path parsing overhead.

## Compatibility

- **Node**: >=22.18.0
- **Browser**: ✓ — no `process`, `Buffer`, or other Node globals
- **Runtime deps**: none
- **Module formats**: ESM + CJS, fully tree-shakeable (`sideEffects: false`)
- **TypeScript**: requires strict mode for `Patch<T>` to give the right inference

## Stability

Public API governed by the [Act Stability Charter](../../STABILITY.md). Charter takes effect at 1.0 (gated on [milestone 1.0](https://github.com/Rotorsoft/act-root/milestone/1)).

## Related packages

- **[@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act)** — the framework whose state reducers consume `patch()`.
- **[@rotorsoft/act-http](https://www.npmjs.com/package/@rotorsoft/act-http)** — uses `patch` in its `/sse` subpath for incremental state broadcast (only sends what changed).

## Documentation

- **[State management](https://rotorsoft.github.io/act-root/docs/concepts/state-management)** — how Act state reducers use `patch` internally.
- **[Real-time with SSE](https://rotorsoft.github.io/act-root/docs/concepts/real-time)** — the wire format that pairs `delta` on the server with `patch` on the client.
- **[Cache and snapshots](https://rotorsoft.github.io/act-root/docs/architecture/cache-and-snapshots)** — how snapshots interact with patch application during replay.

## License

MIT
