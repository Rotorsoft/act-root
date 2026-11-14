---
paths:
  - "libs/**/src/**/*.ts"
---

# Config validation

Every numeric option on a public bag, in core or a satellite, is checked where the bag enters: the builder call, `build()`, a constructor or a factory. `NaN` makes every comparison false, so an unchecked bound is no bound.

- **Zod**, throwing `ZodError`, in every package that depends on zod. act-ops has no dependencies and throws `Error` from plain checks. Never a `*_MIN`/`*_MAX` companion constant.
- **Fail closed, never tighter:** refuse `NaN`, `±Infinity`, and negatives or fractions where they make no sense; never newly refuse a value that works today.
- **Schema:** an internal `const <Type>OptionsSchema`, never exported from an entry point. Where its output is a public type in `types/`, end it in `satisfies z.ZodType<…>` and add a field to both together.
- **Defaults:** a shared or public default is a `DEFAULT_*` constant used in `.default(...)`; a public one lives in `types/act.ts`. A default only one schema uses may be a literal there.
- **Names:** a function that parses and returns the config is `resolve<Type>Config`, camelCase, the one internal exception to naming.md; one that only throws is `check_<thing>`.
- **Home:** act-core's bags live in `libs/act/src/internal/config.ts`, one section per bag; a satellite keeps its bag next to its entry point.
- Override Zod's message only where callers read the wording.
