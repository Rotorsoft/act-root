# RFC 1959: Every public type lives in `types/`

- **Status:** accepted
- **Issue:** #1942
- **Author:** rotorsoft
- **Created:** 2026-10-17

## Motivation

`@rotorsoft/act` declared its public types in five kinds of places: `types/`, `act.ts`, the builder files, `internal/` modules, and a few root modules. So a public type could sit beside its implementation, inside `internal/`, or in the orchestrator file, with no rule saying which. `@rotorsoft/act/types` published about 90 of the roughly 110 public types, and nothing explained why the rest were missing. The stability snapshot copied whole `internal/` files because public names were defined in them, so internal edits read as public changes.

The framework now follows one pattern, by audience. `types/` declares every public type and the public contract values (errors and signals, schemas, sentinels, defaults). The public runtime modules implement them and declare no public types. `internal/` is private: never re-exported, and never imported by `types/`. `architecture.spec.ts` enforces all three rules.

## Public surface added

Existing public names also appear on the `@rotorsoft/act/types` subpath:

- **Types on `./types`:** `ActOptions`, `ActLifecycleEvents`, `CircuitState`, `CircuitBreakerOptions`, `AutocloseConfig`, `AutoclosePolicy`, `ActBuilder`, `StateBuilder`, `ActionBuilder`, `SliceBuilder`, `Slice`, `ProjectionBuilder`, `Projection`, `Config`, `Package`, `CsvFileOptions`, `ExitCode`, `Scoped`.
- **Values on `./types`:** `DeferSignal`, `ExitCodes`, `DEFAULT_SETTLE_DEBOUNCE_MS`, `DEFAULT_MAX_SUBSCRIBED_STREAMS`.
- **`ActOptions.autoSettle`** (default `true`): a local change that frees reaction work (a commit, `reset()`, `unblock()`, `restore()`) settles it on its own. Tests and tools that walk the pipeline with `correlate()` / `drain()` set it `false`. It replaces the `app.on("committed", () => app.settle())` wiring every app needed; a long `settleDebounceMs` was rejected as the off switch because a timing value pretending to mean "off" is not an interface.

The same release removes the deprecated autoclose knobs (`autocloseCycleMinutes`, `closeBatchSize`, `closeYieldMs`, `closeOnError`), their three `DEFAULT_*` constants and the `start_correlations` callback.

The test-helper types `Sandbox` and `SandboxOptions` are declared in `types/sandbox.ts` but published only through `@rotorsoft/act/test`, as before: `types/index.ts` does not re-export them.

## Alternatives considered

- **Keep each public type beside its implementation.** This is cohesive, but public types would stay inside `internal/` (the circuit breaker, the autoclose policy) and inside the orchestrator file. That leaves no single rule, and the snapshot keeps copying internal files.
- **Move types to root-only files so that `./types` doesn't change.** This put `CircuitState` in `act.ts`, next to nothing related to it, and created one-off root modules. It was rejected as inconsistent.
- **Do nothing.** Five placements, and no rule for choosing between them.

## Stability / charter impact

The layering is additive: every name keeps its root import path, and the moved names also appear on `./types`. The removed deprecations and the new default (`autoSettle: true`) change behavior; the user chose to ship them as a minor, with the release note telling writer-only processes to set `drain: false` and tests that walk the pipeline to set `autoSettle: false`. The Zod-inferred public types (`AutoclosePolicy`, `AutocloseConfig`, `CircuitBreakerOptions`, `Config`, `Package`) are now written out in `types/`, and each schema ends in `satisfies z.ZodType<…>`, so a schema whose output no longer matches its public type fails to compile. Declaration files move inside `dist/@types`. The package's `exports` map never exposed those paths.
