# RFC 1959: Every public type lives in `types/`

- **Issue:** #1942
- **Author:** rotorsoft
- **Created:** 2026-10-17

## Motivation

`@rotorsoft/act` declared its public types in five kinds of places: `types/`, `act.ts`, the builder files, `internal/` modules, and a few root modules. So a public type could sit beside its implementation, inside `internal/`, or in the orchestrator file, with no rule saying which. `@rotorsoft/act/types` published about 90 of the roughly 110 public types, and nothing explained why the rest were missing. The stability snapshot copied whole `internal/` files because public names were defined in them, so internal edits read as public changes.

The framework now follows one pattern, by audience. `types/` declares every public type and the public contract values (errors and signals, schemas, sentinels, defaults). The public runtime modules implement them and declare no public types. `internal/` is private: never re-exported, and never imported by `types/`. `architecture.spec.ts` enforces all three rules.

## Public surface added

Existing public names also appear on the `@rotorsoft/act/types` subpath:

- **Types on `./types`:** `ActOptions`, `ActLifecycleEvents`, `CircuitState`, `CircuitBreakerOptions`, `AutocloseConfig`, `AutoclosePolicy`, `ActBuilder`, `StateBuilder`, `ActionBuilder`, `SliceBuilder`, `Slice`, `ProjectionBuilder`, `Projection`, `Config`, `Package`, `CsvFileOptions`, `ExitCode`, `Scoped`, `PatchFn` (the patch step the public `Act` constructor takes, also new on the root).
- **Values on `./types`:** `DeferSignal`, `ExitCodes`, `DEFAULT_SETTLE_DEBOUNCE_MS`, `DEFAULT_MAX_SUBSCRIBED_STREAMS`, `SNAP_EVENT`, `TOMBSTONE_EVENT`, `DEFAULT_LANE`.
- **`ActOptions.autoSettle`** (default `true`): a change that frees reaction work (a commit, `reset()`, `unblock()`, `restore()`, a notification from another process) settles it on its own. Tests and tools that walk the pipeline with `correlate()` / `drain()` set it `false`. It replaces the `app.on("committed", () => app.settle())` wiring every app needed; a long `settleDebounceMs` was rejected as the off switch because a timing value pretending to mean "off" is not an interface.

The same release removes the deprecated autoclose knobs (`autocloseCycleMinutes`, `closeBatchSize`, `closeYieldMs`, `closeOnError`), their three `DEFAULT_*` constants and the `start_correlations` callback. TypeScript callers that still pass the callback get a compile error; plain JavaScript callers get no error, and the callback is ignored.

The test-helper types `Sandbox` and `SandboxOptions` are declared in `types/sandbox.ts` but published only through `@rotorsoft/act/test`, as before: `types/index.ts` does not re-export them.

## Why settling became automatic

Every app wired `app.on("committed", () => app.settle())`, and an app that forgot it ran no reactions until something else woke the drain. The framework already knows when a commit has a local reaction, so it now schedules the settle itself, and `reset()`, `unblock()` and `restore()` do the same. Startup stays explicit: one `app.settle()` runs what was pending before a restart.

Scheduling follows one rule. A pass already scheduled is never put off or replaced: calls before it runs join it (a shorter delay brings it forward), and a call during a running cycle queues one more pass. Only `settle(options)` carries options; the framework's own wake-ups carry none, so they never discard a caller's. What this costs: a reaction that commits while a cycle runs queues one more short pass, so one chain can emit `"settled"` twice; and a lane with `cycleMs` may drain sooner than its cadence when a commit's settle finds work for it. `cycleMs` is a floor, the extra precaution for when `autoSettle` is off, not a rate limit.

The CommonJS build now shares one copy of each class across entry points, so `instanceof` works for an error built from `@rotorsoft/act/types` and checked by the root.

## Alternatives considered

- **Keep each public type beside its implementation.** This is cohesive, but public types would stay inside `internal/` (the circuit breaker, the autoclose policy) and inside the orchestrator file. That leaves no single rule, and the snapshot keeps copying internal files.
- **Move types to root-only files so that `./types` doesn't change.** This put `CircuitState` in `act.ts`, next to nothing related to it, and created one-off root modules. It was rejected as inconsistent.
- **Do nothing.** Five placements, and no rule for choosing between them.

## Stability / charter impact

The layering is additive: every name keeps its root import path, and the moved names also appear on `./types`. The removed deprecations and the new default (`autoSettle: true`) change behavior; the user chose to ship them as a minor, with the release note telling writer-only processes to set `drain: false` and tests that walk the pipeline to set `autoSettle: false`. The Zod-inferred public types (`AutoclosePolicy`, `AutocloseConfig`, `CircuitBreakerOptions`, `Config`, `Package`) are now written out in `types/`, and each schema ends in `satisfies z.ZodType<…>`, so a schema whose output stops fitting its public type fails to compile. The check runs one way: an optional field added to the type but not to the schema still compiles, and parsing drops it. Declaration files move inside `dist/@types`. The package's `exports` map never exposed those paths.
