---
id: migrating-to-2.x
title: Migrating to 2.x
sidebar_position: 21
---

# Migrating to 2.x

> Applies to: `@rotorsoft/act@1` → `@rotorsoft/act@2`, and the adapters that track core ([Stability Charter](https://github.com/Rotorsoft/act-root/blob/master/STABILITY.md)).

## TL;DR

Most apps change only what the compiler points at: `.given` becomes `.requires`, and a few `.emit` handlers need their extra fields removed. Direct callers of `Store.commit` and third-party adapters move to `commit(appends, meta)`. [Rules across streams](./rules-across-streams.md) is what 2.0 adds.

**Upgrade every `@rotorsoft/act*` package in the same step.** Their old versions don't work with act 2, and pnpm only warns about that. Act refuses a store still written for the old `commit` when it's injected, but a wrapper taking `(...args)` gets past that check. An old `act-notify` of that kind would send the appends, sensitive fields included, to your broker.

```bash
pnpm up "@rotorsoft/act*@latest"
```

## Breaking changes

### `Store.commit` takes a list of appends

- **What changed:** `commit(stream, msgs, meta, expectedVersion?)` is now `commit(appends, meta)`, each append being `{ stream, msgs, expectedVersion? }`.
- **Why:** so one action can append to several streams in one step ([RFC 2251](https://github.com/Rotorsoft/act-root/blob/master/rfcs/2251-rules-across-streams.md)).
- **How to update:** only direct callers and adapters are affected, since `app.do` makes this call for you.

```ts no-check
// before (1.x)
await store.commit(stream, msgs, meta, expectedVersion);

// after (2.x)
await store.commit([{ stream, msgs, expectedVersion }], meta);
```

An adapter checks every append's version before inserting anything, and inserts them all in one transaction. [Upgrading an adapter](./writing-a-store.md#upgrading-an-adapter-to-20) has the details, and the TCK's [new block](./tck-conformance.md#what-20-adds) proves them.

Two things that rewrite doesn't show:

- **An append with no events now throws.** `commit(stream, [], meta, version)` used to check the version and return `[]`; `commit([{ stream, msgs: [] }], meta)` throws an `Error`. Skip the call instead. `commit([], meta)` returns `[]`.
- **A wrapper around a `Store`** can't always be caught at build: `act().build()` refuses a four-parameter `commit`, but one with a default or rest parameter passes, and then fails at its first commit. It moves to the new signature too, and sends one notification for each stream a commit appends to, as `withBroker` does.

### Invariants are preconditions

- **What changed:** `.given`, `Invariant`, `InvariantError`, `Errors.InvariantError`, act-http's `INVARIANT` code and the `validateFoldedState` option are gone.
- **Why:** each of them guarded one action, so each was a precondition. The real invariants of a domain now live in the state's schema, checked before every commit.
- **How to update:**
  - Write `.given([rule])` as `.requires([rule])`, merging it with any `.requires` on the same action, with `valid: (state, actor) => ...` becoming `holds: (_, state, actor) => ...`, and type a shared rule `Precondition<S, unknown>` instead of `Invariant<S>`.
  - Catch `PreconditionError` instead of `InvariantError`; `Errors.InvariantError` (`ERR_INVARIANT`) is gone, and act-http no longer has the `INVARIANT` code.
  - A direct call to a rule's `holds` passes all four arguments, `holds(payload, state, actor, loaded)` (`{}` when the action loads nothing), and a direct call to an action handler in `state.on` passes `loaded` as its fourth argument. A rule written with fewer parameters still fits, so `.requires([...])` needs no change.
  - Remove `validateFoldedState` from `act().build(...)`: invariants are the state's schema, checked before every commit, and the option has been ignored since 1.35.
  - A state field cleared with `null` in a patch must be `.optional()` or `.nullish()`. `null` deletes the key, so a `.nullable()` field, which requires the key, refuses every action after the one that cleared it (since 1.35).
- **What code sees:** a refusal that was `ERR_INVARIANT`, "failed invariant: ..." is now `ERR_PRECONDITION`, "failed precondition: ...", and act-http's code goes from `INVARIANT` to `PRECONDITION`, still 409. `PreconditionError` now extends `Error` directly.
- **Coming from 1.34 or earlier:** the schema check on the state before every commit is new to you. A stream whose state already breaks its schema, say a `.nullable()` field cleared with `null`, refuses every action with `ValidationError` until you relax the schema or repair the field. Replay your important streams against the schema before upgrading.

```ts no-check
// before (1.x)
.given([{ description: "must be open", valid: (state) => state.open }])

// after (2.x)
.requires([{ description: "must be open", holds: (_, state) => state.open }])
```

`.requires` comes once per action. If you had `.given([a]).requires([b])`, write `.requires([a, b])`, which keeps the order they ran in.

### `.emit` checks what a handler returns

- **What changed:** a field its event's schema doesn't declare fails to compile; it used to be dropped silently. A handler with no return value (`() => {}`) fails to compile, and so does one that appends to no stream of its own. A handler that only throws still compiles. `.emit("Event")` compiles only for an event the payload can satisfy; it used to compile and then refuse every call.
- **Why:** an action's mistakes should show in the editor, on the line that made them.
- **How to update:** remove the field or add it to the schema, and return `undefined` to commit nothing. An `.emit` inside a generic helper, where the event's type isn't known yet, may need the name form.

```ts no-check
// before (1.x): compiled, and dropped `extra`
.emit((data) => ["TicketClosed", { ...data, extra: 1 }])

// after (2.x)
.emit((data) => ["TicketClosed", data])
```

### A target reads one source

- **What changed:** two static reactions on one target with different sources now throw at build.
- **Why:** a subscription row holds one source, so the second reaction's events were silently never delivered.
- **How to update:** keep the target name on the reaction that has been delivering, and give the other one a new target. Leaving out `source` also builds, but then both reactions read every stream.

```ts no-check
// before (1.x): built, and `onTaken` never ran
.on("Done").do(onDone).to({ target: "audit", source: "orders" })
.on("Taken").do(onTaken).to({ target: "audit", source: "seats" })

// after (2.x)
.on("Done").do(onDone).to({ target: "audit", source: "orders" })
.on("Taken").do(onTaken).to({ target: "audit-seats", source: "seats" })
```

**Don't rename the target that has been working.** A new target reads its source from the start, so renaming `audit` would run `onDone` over its whole history again, and a webhook would resend every delivery. `onTaken` above does read from the start, which is what you want: it never ran.

### A reaction's source is a regex only when anchored

- **What changed:** a `source` is a pattern only if it starts with `^` or ends with `$`. Anything else is a stream's exact name, whatever characters it holds.
- **Why:** a name like `user+tag@example.com` or `order(1)` used to read as a regex, so its reactions never ran, and on SQLite one such name stopped every reaction in the app.
- **How to update:** anchor any pattern you wrote. It stops matching otherwise, with no error. `app.reset`, `query` and the other filters are unchanged.

```ts no-check
// before (1.x)
.to({ target: "orders", source: "order-.*" })

// after (2.x)
.to({ target: "orders", source: "^order-" })
```

### A result's `version` is the stream's head

- **What changed:** when `.snap` fires after an action, the last snapshot's `version` is the snapshot's, not the event's. `event.version` is unchanged.
- **Why:** it's documented as the head, and pinning to anything older refuses your own next action.
- **How to update:** pin a later action to `version`, not `event.version`.

### act-http's snake_case SSE aliases are gone

- **What changed:** the deprecated aliases in `@rotorsoft/act-http/sse` are removed.
- **Why:** they were announced for removal in the next major, and this is it.
- **How to update:** rename them.

| Removed | Use |
|---|---|
| `publish_overlay` | `overlay` |
| `get_subscriber_count` | `subscriberCount` |
| `get_state` | `state` |
| `cache_size` | `cacheSize` |
| `get_online` | `online` |
| `is_online` | `isOnline` |

## Deprecations (not yet removed)

Nothing new is deprecated in 2.0, and this still works:

- **`@rotorsoft/act-tck`:** the `work_set` capability. It's ignored.

### Deprecated in 2.x, removed in 3.0

A 2.x minor gives each audience its own entry point ([RFC 2411](https://github.com/Rotorsoft/act-root/blob/master/rfcs/2411-adapter-subpath.md)). Every old name keeps working, marked deprecated, until 3.0. Move to the new name when convenient:

| Old name (on `@rotorsoft/act`) | Use instead |
|---|---|
| `check_appends` | `checkAppends` from `@rotorsoft/act/adapter` |
| `throw_if_stale` | `checkVersion` from `@rotorsoft/act/adapter` |
| `concurrency_error` | `concurrencyError` from `@rotorsoft/act/adapter` |
| `seed_event` | `seedEvent` from `@rotorsoft/act/adapter` |
| `fair_slots` | `fairSlots` from `@rotorsoft/act/adapter` |
| `is_literal_source` | `isStreamName` from `@rotorsoft/act/adapter` |
| `notification_of` | `parseNotification` from `@rotorsoft/act/adapter` |
| `pii_fields` (also on `/types`) | `sensitiveFields`, from `@rotorsoft/act` or `/types` |
| `DEFAULT_QUERY_STREAMS_LIMIT`, `ActorSchema`, `TargetSchema`, `EventMetaSchema`, `CausationEventSchema`, `CommittedMetaSchema`, `QuerySchema`, `Environments`, `LogLevels`, `ExitCodes`, `DEFAULT_LANE`, `DEFAULT_MAX_SUBSCRIBED_STREAMS`, `DEFAULT_SETTLE_DEBOUNCE_MS` | the same name from `@rotorsoft/act/types` |
| `PackageSchema`, `default_scope`, `resolveAutocloseConfig`, `dateReviver`, `extend` | nothing: `config()` and `act().build()` validate for you, `store()`/`cache()`/`log()` give the unscoped adapters, and a host app can write its own reviver |

## Nothing to do

- **Your data.** No table or column changes, so a 1.x store opens as it is. 1.x and 2.0 workers can share a Postgres store during a rolling deploy, and 1.x reads events a 2.0 commit wrote if you roll back.
- **The `Cache` and `Logger` ports.** Unchanged.
- **`committed` listeners.** An app that doesn't use `.loads` still gets one per action.
- **Reactions, projections, close policies and events.** Unchanged.
