# RFC 1139: camelCase aliases for snake_case sse public members

- **Status:** accepted <!-- draft | accepted | rejected | superseded -->
- **Issue:** #1139
- **Author:** Claude (with Rotorsoft)
- **Created:** 2026-07-05

## Motivation

The repo's naming convention is unambiguous: anything reachable from a package
entry point is camelCase; snake_case is reserved for internals. An audit of
every declared entry point (#1139) found one cluster of public **methods**
that slipped through before the convention was mechanically enforced: the
`@rotorsoft/act-http/sse` classes. `BroadcastChannel` shipped
`publish_overlay`, `get_state`, `get_subscriber_count`, and a `cache_size`
constructor option; `PresenceTracker` shipped `get_online` and `is_online`.
Users copying from these classes get the wrong signal about what the
convention is; the stability snapshot then locks the wrong names in.

The same audit found five snake_case **fields** elsewhere that are deliberate
charter echoes, not slips, and are explicitly out of scope:
`SqliteConfig.pii_encryption` (act-sqlite), the `PostgresStore` config field
`pii_encryption` (act-pg), and `StoreCapabilities.pii_isolation` /
`.concurrent_claim` / `.source_matches` (act-tck). They mirror the core
charter surface they gate or configure (`Store.forget_pii` and the `pii_*`
family, the claim contract, `QueryStreams.source_matches`), where a casing
switch would break the 1:1 correspondence with established charter names.
Core `IAct`/`Store` names (`query_array`, `query_streams`, `blocked_streams`,
`forget_pii`, …) are established charter surface and likewise untouched.

## Public surface added

All on `@rotorsoft/act-http/sse` (re-exported by the deprecated
`@rotorsoft/act-sse` shim). The new names become the canonical
implementations; each snake_case member remains fully functional, delegates
to its new counterpart, and is marked `@deprecated … removal in the next
major`.

- **`BroadcastChannel.overlay(streamId: string, overlay_patch: Partial<S>): PatchMessage<S> | undefined`** — alias of `publish_overlay`.
- **`BroadcastChannel.state(streamId: string): S | undefined`** — alias of `get_state`.
- **`BroadcastChannel.subscriberCount(streamId: string): number`** — alias of `get_subscriber_count`.
- **`BroadcastChannel` constructor option `cacheSize?: number`** — alias of `cache_size`; when both are given, `cacheSize` wins (documented on the constructor).
- **`PresenceTracker.online(streamId: string): Set<string>`** — alias of `get_online`.
- **`PresenceTracker.isOnline(streamId: string, identity_id: string): boolean`** — alias of `is_online`.

No builder methods, port methods, or lifecycle events. `StateCache`,
`applyPatchMessage`, and the `sse` type exports were audited and are already
conforming.

## Alternatives considered

- **Mechanical `getX` conversions (`publishOverlay`, `getState`,
  `getSubscriberCount`, `getOnline`).** Considered first — a 1:1 casing
  transliteration of the deprecated names. Rejected in favor of matching the
  classes' existing short-verb/accessor style (`publish`, `subscribe`,
  `cache`, `add`, `remove`): the standing naming rule is "match existing
  analogs, default to the shortest defensible name," and `getSubscriberCount`
  would have been the odd member out on its own class, not `publish`.
  `isOnline` keeps its predicate prefix (shortest defensible form for a
  boolean); `subscriberCount` keeps the noun because a bare `subscribers`
  returning a number would mislead.
- **Breaking rename (remove the snake_case members now).** Rejected: the sse
  surface has published 1.7.x callers (`act-sse` shipped these names, and
  `act-http/sse` inherited them verbatim). A rename would force a major bump
  for a cosmetic fix. Deprecation gives callers a full major cycle to migrate.
- **Do nothing.** Rejected: the convention is mechanically enforced for new
  code via the stability snapshot review, and docs/skills present these
  classes as the canonical real-time pattern. Leaving the only nonconforming
  cluster in place keeps teaching the wrong convention.
- **snake_case member keeps the implementation, the new name delegates.**
  Rejected: at removal time the body would have to move anyway; making the
  new name canonical now means the next-major cleanup is a pure deletion.
- **Also alias the five charter-echo fields (`pii_encryption`,
  `pii_isolation`, `concurrent_claim`, `source_matches`).** Rejected: they
  deliberately mirror charter-established core names; renaming them would
  trade convention conformance on one axis for cross-surface inconsistency on
  a more load-bearing one.

## Stability / charter impact

- Category: public types / adapter-package exports (`@rotorsoft/act-http/sse`
  class members). Not core `IAct` or port surface.
- Everything is **additive** — the snake_case members keep their exact
  behavior and signatures; only `@deprecated` JSDoc is added. Ships as a
  minor (`feat`). Removal of the snake_case members is deferred to the next
  major, where it will carry a `BREAKING CHANGE:` footer and migration note.
- No port methods added; the TCK is unaffected beyond the regenerated
  all-packages stability snapshot (legitimate growth — this RFC satisfies the
  rfc-gate).

## Open questions

None.
