---
paths:
  - "libs/**/src/**/*.ts"
---

# Config-validation schemas

Any options bag that ships to `act().build()` / `openapi(app, ...)` / similar entry points is validated with Zod, not hand-written `if (x < min) throw` ladders. Out-of-range values throw `ZodError` at the entry point so misconfiguration surfaces at startup, not on the first cycle tick. The standard:

| Element | Convention |
|---|---|
| Schema name | `<Type>OptionsSchema` — `AutocloseOptionsSchema`, `SseOptionsSchema`, `OpenAPIOptionsSchema` |
| Schema visibility | Internal `const`, never re-exported. The public surface is the type + resolver, not the schema itself. |
| Config type | Internal: `type <Type>Config = z.infer<typeof <Type>OptionsSchema>`. Public: written out in `types/`, and the schema ends in `satisfies z.ZodType<…>`, so a schema whose output stops fitting the type fails to compile (a field added to the type but not the schema still compiles, and parsing drops it: add both together). |
| Resolver | `resolve<Type>Config(options: <Type>Options): <Type>Config` — camelCase, parses + applies defaults in one call |
| Defaults | `DEFAULT_*` SCREAMING_SNAKE constants, referenced from the schema via `.default(DEFAULT_*)` so there's one source of truth; a public default lives in `types/act.ts` |
| Custom error messages | `{ message: "..." }` on the individual constraint when callers depend on the wording (test assertions, structured logs). Don't override Zod's default for shape errors callers don't read. |

**Single home:** every builder-facing act-core config bag (schema + resolver + private `DEFAULT_*`) lives in **`libs/act/src/internal/config.ts`**; a resolver that is public (`resolveAutocloseConfig`) is a one-line wrapper in the public `config.ts` — one discoverable module, one section per bag (`Backoff`, `Reaction`, `Action`, `Lane`, `Drain`/`Settle`, `Act`, `Autoclose`, `CircuitBreaker`, `Fold`). Feature logic (the `CircuitBreaker` state machine, the fold engine, the autoclose window math in `autoclose-window.ts`) imports its resolved-config type from there. A new config bag adds a section to `config.ts` and wires its `resolve<Type>Config` at the declaration/runtime site (`.on(...)` / `.do(...)` / `.withLane(...)` / `act().build(...)` / `drain(...)` / `settle(...)`) — never a hand-rolled range check. Validation is fail-closed but non-tightening: reject `NaN`/`±Infinity`/nonsensical-negatives, never newly reject a value that works today. The sibling env/package config (`config()`) stays in the public `libs/act/src/config.ts`; `@rotorsoft/act-http` transport bags (`sse-wiring.ts`, `openapi/index.ts`) stay in that package. Never reinvent `*_MIN` / `*_MAX` companion constants or scatter ladders across the resolver.
