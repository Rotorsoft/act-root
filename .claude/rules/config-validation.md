---
paths:
  - "libs/**/src/**/*.ts"
---

# Config validation

Every input a caller hands in, in core or a satellite, is checked where it enters: the builder call, `build()`, an `Act` method, a constructor or a factory. `NaN` makes every comparison false, so an unchecked bound is no bound.

**One way to do it.** Option bags have no validator functions: no `resolve<Type>Config`, `check_<thing>`, `assert_<thing>`, `validate_<thing>` or `is_valid_<thing>` wrapper around an options schema, written as a `function` or as an arrow `const`. Before adding validation, grep for those prefixes; a hit outside a public export is a defect to fix in the same PR. The rule covers option bags only: checks on domain data (`check_invariants` on a state) keep their names.

- **Core:** every bag's schema is a private `const` in `libs/act/src/internal/config.ts`, listed in its `SCHEMAS` table. Callers write `check("<kind>", options)`, which throws `ZodError` and returns the parsed, defaulted bag; a caller that only needs the throw ignores the result. A new bag is a schema plus one table row, never a new function. Where a check must not throw (a resolver's result in a cycle), wrap `check` in `try`/`catch`.
- **Satellites:** the schema is a private `const <Type>OptionsSchema` next to the entry point, which calls `<Type>OptionsSchema.parse(options)` inline. Entry points that share a bag (act-http's receivers) import the one schema, not a wrapper.
- **Not a bag check:** a rule that compares a bag against the registry (an undeclared lane, a reserved name, a duplicate handler) is a plain `throw new Error(...)` where the registry is assembled.
- **Its contract row:** a newly checked option adds its test to the one option-refusal row in `docs/docs/architecture/behavior-contracts.md` ("Every option is checked where it enters"), not a row of its own.
- **Zod**, in every package that depends on it. act-ops has no dependencies and throws `Error` from plain checks, and so does act-http's `BroadcastChannel`, which browser bundles import through `/sse` and must reach no zod. Never a `*_MIN`/`*_MAX` companion constant.
- **Fail closed, never tighter:** refuse `NaN`, `±Infinity`, and negatives or fractions where they make no sense; never newly refuse a value that works today.
- **Types:** where a schema's output is a public type in `types/`, end it in `satisfies z.ZodType<…>` and add a field to both together. Schemas are never exported from an entry point.
- **Defaults:** a shared or public default is a `DEFAULT_*` constant; a public one lives in `types/act.ts`. A satellite applies it with `.default(...)` in its schema. Core applies it with `??` where the value is read, since most callers of `check` ignore its result. A default only one schema uses may be a literal there.
- Override Zod's message only where callers read the wording.
