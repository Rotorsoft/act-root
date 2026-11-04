---
id: migrating-to-2.x
title: Migrating to 2.x
sidebar_position: 21
---

# Migrating to 2.x

> Applies to: `@rotorsoft/act@1` → `@rotorsoft/act@2`, and the adapters that track core ([Stability Charter](https://github.com/Rotorsoft/act-root/blob/master/STABILITY.md)).

## TL;DR

Most apps change only what the compiler points at: `.given` becomes `.requires`, and a few `.emit` handlers need their extra fields removed. Direct callers of `Store.commit` and third-party adapters move to `commit(appends, meta)`. [Rules across streams](./rules-across-streams.md) is what 2.0 adds.

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

### Invariants are preconditions

- **What changed:** `.given`, `Invariant`, `InvariantError`, `Errors.InvariantError`, act-http's `INVARIANT` code and the `validateFoldedState` option are gone.
- **Why:** each of them guarded one action, so each was a precondition. The real invariants of a domain now live in the state's schema, checked before every commit.
- **How to update:** see [Upgrading from `.given`](../concepts/state-management.md#upgrading-from-given-removed-in-20).

```ts no-check
// before (1.x)
.given([{ description: "must be open", valid: (state) => state.open }])

// after (2.x)
.requires([{ description: "must be open", holds: (_, state) => state.open }])
```

### `.emit` checks what a handler returns

- **What changed:** a field its event's schema doesn't declare fails to compile; it used to be dropped silently. A handler that never returns anything fails to compile, and so does one that appends to no stream of its own.
- **Why:** an action's mistakes should show in the editor, on the line that made them.
- **How to update:** remove the field or add it to the schema, and return `undefined` to commit nothing. An `.emit` inside a generic helper, where the event's type isn't known yet, may need the name form.

```ts no-check
// before (1.x): compiled, and dropped `extra`
.emit((data) => ["TicketClosed", { ...data, extra: 1 }])

// after (2.x)
.emit((data) => ["TicketClosed", data])
```

## Deprecations (not yet removed)

None.
