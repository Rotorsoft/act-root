# RFC 2411: One entry point per audience, and `@rotorsoft/act/adapter` for port implementers

- **Issue:** #2411
- **Author:** rotorsoft
- **Created:** 2026-11-11

## Motivation

`src/index.ts` re-exports eight whole modules with `export *`, so anything added to `utils.ts`, `ports.ts` or `config.ts` becomes public without anyone deciding it should. The root now serves three audiences at once: apps (the builders, ports, errors and in-memory adapters), store authors (the rule helpers each adapter calls so the rule lives once in core, #2387 and #2388), and nobody (16 names with no caller outside core and no doc).

The store helpers are also where the naming broke. Exported functions are camelCase (27 of 31), but `check_appends`, `throw_if_stale`, `concurrency_error`, `seed_event`, `fair_slots`, `is_literal_source`, `notification_of` and `pii_fields` are snake_case, because they were written as internal code and exported later. A third-party adapter author has no single place to read what core gives them.

The package already splits by audience: `.` for apps, `/types` for the contract, `/test` for tests. This RFC adds the missing one, `/adapter`, and makes each entry point say exactly what it exports.

## Public surface added

All additive. Ships in the next 2.x minor.

### `@rotorsoft/act/adapter` (new subpath)

The rules a `Store` implementation calls. Functions only, each a pure function of its arguments.

| Signature | Replaces | The rule |
|---|---|---|
| `checkAppends(appends): void` | `check_appends` | A commit refuses an append with no events and a stream named twice |
| `checkVersion(append, head): void` | `throw_if_stale` | A commit refuses an append whose `expectedVersion` is not the head |
| `concurrencyError(append, head): ConcurrencyError` | `concurrency_error` | The error for a race found at insert time (no `expectedVersion` reads as `-1`) |
| `seedEvent(snapshot?, meta?): { name, data, meta }` | `seed_event` | What a full `truncate` seeds a stream with: a snapshot, or a tombstone |
| `fairSlots(lagging): number` | `fair_slots` | How many claim slots ignore priority |
| `isStreamName(source, target?): boolean` | `is_literal_source` | A source is a stream's name unless anchored with `^` or `$` |
| `parseNotification(raw): StoreNotification \| undefined` | `notification_of` | The commit notification in a raw payload, or none |

The two that throw on a violation both start with `check`. Signatures are unchanged from today's helpers; only the names and the import path move. An adapter can import them by name, or as `import * as adapter from "@rotorsoft/act/adapter"` for `adapter.checkAppends(...)` call sites.

### `@rotorsoft/act` (root)

- **`sensitiveFields(schema): readonly string[]`**, replacing `pii_fields` ([RFC 1228](1228-pii-fields-introspection.md)) under a name that pairs with `sensitive()`. It stays on the root: act-http reads it for an app's schemas, and an integration built on an app uses the app's entry point.

### `@rotorsoft/act/types`

- **`DEFAULT_QUERY_STREAMS_LIMIT`** moves from `utils.ts` to `types/ports.ts`. It is a default of the `Store` contract, and [RFC 1959](1959-public-types-in-types.md) puts contract values in `types/`. Same name, same value.

### Deprecated in the same minor, removed in 3.0

Each keeps working as an alias, marked `@deprecated` with its replacement:

- From the root: the seven helpers above, `pii_fields`, `DEFAULT_QUERY_STREAMS_LIMIT`.
- From the root, staying on `/types`: `ActorSchema`, `TargetSchema`, `EventMetaSchema`, `CausationEventSchema`, `CommittedMetaSchema`, `QuerySchema`, `Environments`, `LogLevels`, `ExitCodes`, `DEFAULT_LANE`, `DEFAULT_MAX_SUBSCRIBED_STREAMS`, `DEFAULT_SETTLE_DEBOUNCE_MS`. They describe the contract, and RFC 1959 published them on `/types` deliberately; an app has no use for them.
- Everywhere: `PackageSchema`, `default_scope`, `resolveAutocloseConfig`, `dateReviver`, `extend`. Nothing outside core calls them.

## Where each name lives after 3.0

| Entry point | Audience | Holds |
|---|---|---|
| `@rotorsoft/act` | apps and integrations | Builders (`act`, `state`, `slice`, `projection`, `Act`), ports (`store`, `cache`, `log`, `port`, `dispose`, `disposeAndExit`), `config`, in-memory adapters (`InMemoryStore`, `InMemoryCache`, `ConsoleLogger`), `CsvFile`, `sensitive`, `sensitiveFields`, `REDACTED`, `SHREDDED`, `ZodEmpty`, `validate`, `sleep`, the errors (`Errors`, `ValidationError`, `PreconditionError`, `ConcurrencyError`, `StreamClosedError`, `StoreError`, `NonRetryableError`, `DeferSignal`), the markers `SNAP_EVENT` and `TOMBSTONE_EVENT`, and every public type |
| `@rotorsoft/act/types` | the contract | Every public type and contract value (errors, markers, schemas, defaults), unchanged from RFC 1959 plus `DEFAULT_QUERY_STREAMS_LIMIT` |
| `@rotorsoft/act/adapter` | port implementers | The seven rule functions |
| `@rotorsoft/act/test` | tests | `fixture`, `sandbox`, unchanged |

The root's runtime names become an explicit list. Types still come through `export type * from "./types/index.js"`: a type-only re-export adds no runtime name, and RFC 1959 already gates what `types/` declares.

An adapter imports types, errors and markers from `/types` (or the root), rules from `/adapter`, and ports such as `log` from the root. act-pg, act-sqlite, InMemory, act-notify and act-tck move to `/adapter`; act-http moves to `sensitiveFields`; the inspector example keeps its root imports.

## Guards

`libs/act/test/architecture.spec.ts` gains three rules:

1. **No runtime `export *`** in `src/index.ts` or `src/adapter.ts`. A new public value is a line in the list, visible in review.
2. **`src/adapter.ts` imports only from `types/`** and exports only functions. A rule can't reach for a port, `config` or `scoped`, so each one stays unit-testable and free of ambient state. All seven meet this today.
3. **The existing check stays:** no adapter restates a framework rule.

`pnpm check:stability` snapshots every subpath in `exports`, so `/adapter` is covered as soon as it ships.

## Naming

`.claude/rules/naming.md` is rewritten to what the code does:

- **camelCase:** exported functions, factories, builder methods, options fields.
- **snake_case:** port methods and record, query and result fields (`query_stats`, `with_snaps`, `correlated_at`), by design.
- **`SCREAMING_SNAKE`:** exported constants (`SNAP_EVENT`, `DEFAULT_*`, `REDACTED`).
- **Short snake_case:** everything internal and private.

Port methods and record fields are not renamed.

## Alternatives considered

- **A builder, `defineStore({ commit, query, ... })`.** It could apply only two of the nine rules itself: refusing bad appends and parsing notifications. The version check, the race error, the seed, fair slots and source matching all need the store's transaction or query, so they stay calls the adapter makes. It also adds a concept (a wrapped store versus a plain `Store`) that the TCK, `withBroker` and `check_store` would have to see through, and it still leaves six calls.
- **A kit object, `adapter.checkAppends(...)`, exported from the root.** One name, but a hand-built object with its own type: a bundler can't drop the rules an adapter doesn't use, and every new rule edits the object. A namespace import of the subpath gives the same call sites for free.
- **A subpath without guards.** The issue calls a subpath "the least encapsulated" option. The explicit export list and the import rule above close that gap.
- **Remove the unused contract values from `/types` too.** That reverses RFC 1959, merged less than a month ago, for names that cost nothing on a types entry point. Leaving the root is enough to keep them out of an app's way.
- **Do nothing.** Every helper added for an adapter keeps becoming app surface by accident, and the snake_case exports stay.

## Stability / charter impact

- **Category:** public type exports, plus a new covered subpath.
- **2.x minor (additive, `feat(act)`):** adds `/adapter`, `sensitiveFields` and `DEFAULT_QUERY_STREAMS_LIMIT` on `/types`; deprecates the names above as aliases; moves the in-repo adapters and integrations onto the new names; rewrites `naming.md`; updates [Writing a store](../docs/docs/guides/writing-a-store.md), [Sensitive data](../docs/docs/guides/sensitive-data.md) and the other guides that name the old helpers, and the STABILITY.md paragraph that lists them. Nothing breaks. The satellites change only their imports and ship as patches, with a published peer range of `^2.<minor>`.
- **3.0 (breaking, `feat(act)!`):** the root becomes the explicit list and every deprecated alias is removed, with a `BREAKING CHANGE:` footer and a migration table (old name → new name and entry point) in the 3.x migration guide. No adapter code changes in that PR, because the satellites already moved in the minor. It can wait to ship with other breaking work.
- **No port method changes,** so no TCK or adapter matrix work beyond the import moves. Every in-repo adapter keeps passing the TCK.

## Open questions

None. `dateReviver` is deprecated with the rest: its doc-comment addresses host apps that parse Act JSON, but nothing calls it, and a host can write the same reviver in a few lines.
