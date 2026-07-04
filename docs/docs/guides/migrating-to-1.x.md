---
id: migrating-to-1.x
title: Migrating to 1.x
sidebar_position: 20
---

# Migrating to 1.x

> Applies to: `@rotorsoft/act@1.x` and the adapters that track it (`act-pg`,
> `act-sqlite`, `act-patch`, `act-http`, `act-pino`, `act-tck`). See the
> per-library table in [STABILITY.md](https://github.com/Rotorsoft/act-root/blob/master/STABILITY.md#per-library-status).

## TL;DR

The `1.x` line is the first versioned snapshot of Act, and nothing inside it breaks. The [Stability Charter](https://github.com/Rotorsoft/act-root/blob/master/STABILITY.md) took effect here: every covered surface — the builder DSL, the `IAct` runtime, the `Store`/`Cache`/`Logger` contracts, the lifecycle events, and the public types — is frozen against breaking changes for the life of the major. So upgrading from one `1.x` release to a newer `1.x` release is the boring kind of upgrade: bump the version, reinstall, run your tests. There is no code to rewrite, because by definition a minor or patch release cannot ask you to.

This page exists for two reasons. The first is to say that plainly, so you don't go hunting for a migration you don't have to perform. The second is to prove the migration convention end to end while the stakes are zero — when the first breaking release does land, the author fills in the template below instead of inventing the format under pressure.

## Why there's nothing to migrate

Act follows semantic versioning the strict way the charter describes it. A new feature — a new optional builder method, a new optional field on an options bag, a new lifecycle event name — is additive, ships in a **minor**, and leaves every existing call site compiling and behaving exactly as before. A bug fix that doesn't change a documented contract ships in a **patch**. Only a change that renames a method, removes an export, narrows an output type, or alters the meaning of an existing call counts as breaking, and a breaking change is the one thing a `1.x` release is not allowed to contain. It would force the version to `2.0.0`, and a new major is the only place a migration guide like this one carries instructions.

That guarantee is not aspirational. The public surface is snapshotted by `runStabilityTck` in every package's `test/stability.spec.ts`, so any rename, removal, or signature change shows up as a failing snapshot in the pull request that introduced it — long before it could reach you. If you want to know exactly what that net is stretched over, the charter enumerates it category by category.

## How to upgrade within the line

Pull the newest `1.x` release and let your test suite confirm the upgrade. The framework treats "always be on the latest minor" as the supported posture rather than something to ration:

```bash
pnpm up "@rotorsoft/act@^1" "@rotorsoft/act-pg@^1" "@rotorsoft/act-sqlite@^1"
```

Then the same three checks you'd run after any dependency bump, in order of how much they tell you. Your TypeScript build is the first gate — because the public surface is typed and snapshot-tested, a clean `pnpm typecheck` means no covered shape moved under you. Your own test suite is the second; it's where behavioral expectations specific to your domain get re-confirmed. And if you maintain a custom `Store`, `Cache`, or `Logger`, the third is `@rotorsoft/act-tck` — the executable form of the adapter contract. If your adapter still passes the TCK against the new release, it still honors the contract, and any change that *would* affect you fails the TCK first.

The support window is the backdrop for all of this. While `1.x` is the active line it receives features, fixes, and security patches; there are no long-lived patch branches behind the latest minor, which is exactly why staying current is the recommendation rather than a chore. When a future `2.0` ships, `1.x` enters a maintenance window of at least six months for security and critical-correctness fixes only, and that is the moment this page stops being a formality. The full policy lives in [STABILITY.md § Support window](https://github.com/Rotorsoft/act-root/blob/master/STABILITY.md#support-window).

## Reading the versioned docs

The documentation site is [versioned](https://docusaurus.io/docs/versioning), and the distinction matters once more than one major exists. The live docs you're reading — the **Current** set — always track the latest API on `master`; they are intentionally *not* frozen with library releases, so a concept page can be corrected or expanded without cutting a new version. Each released line is also snapshotted under `docs/versioned_docs/` and selectable from the **version dropdown** in the navbar. When a `2.x` arrives, a reader still on `1.x` picks `1.x` from that dropdown to get the API reference pinned to the release they actually run, and the `2.x` migration guide sits in the navbar right next to the docs it describes. Today the dropdown offers `1.x` and Current; the mechanism is in place and waiting for the next snapshot.

## Breaking changes

None. The `1.x` line introduces no breaking change to migrate away from — it is the baseline every later guide measures against. When the first breaking release lands, this is where each change gets its own subsection: what the old shape was, what the new shape is, one sentence on why with a link to the issue, and a before/after code block showing the smallest edit that updates a call site. The shape of that subsection is fixed by the [migration template](https://github.com/Rotorsoft/act-root/blob/master/MIGRATING.md), so the only open question at the time will be the content, never the format.

## Deprecations (not yet removed)

A deprecation is the charter's early-warning system: a surface keeps working, is marked deprecated in its release notes and doc-comment, and is removed no earlier than the next major — so anything you depend on survives at least until a major boundary you opt into.

One such marker is live in the `1.x` line. `@rotorsoft/act-sse` has moved to `@rotorsoft/act-http/sse`; the old package is now a thin re-export shim that receives bug fixes only and is scheduled for removal in a future major. Migrating off it is a one-line import change, and there is no rush — it will keep working across the whole `1.x` line.

```ts no-check
// before — deprecated package
import { broadcast } from "@rotorsoft/act-sse";

// after — canonical home, identical surface
import { broadcast } from "@rotorsoft/act-http/sse";
```

On the data plane, the `_v<n>` versioned-event-name convention is the parallel mechanism for evolving event shapes without ever rewriting history; it is not an API migration and is covered in [Event Schema Evolution](../architecture/event-schema-evolution.md).

## Nothing-to-do

Everything the charter covers is unchanged across the `1.x` line, which is the whole point — so if you only read one section, read this one and stop. The builder DSL (`state`, `slice`, `projection`, `act` and their methods), the `IAct` runtime (`do`, `load`, `query`, `query_array`, `drain`, `settle`, `correlate`, `reset`, `unblock`, `blocked_streams`, `close`, `forget`, `audit`), the `Store`/`Cache`/`Logger` adapter contracts, the lifecycle events, and every public type export are all stable within the major. The only optional action items above are the `act-sse` import swap, which you can do whenever it's convenient, and staying current with the latest `1.x` release, which is the supported posture rather than a migration.

When the next major arrives, start at the top of its guide instead — but for `1.x`, there is genuinely nothing further to do.
