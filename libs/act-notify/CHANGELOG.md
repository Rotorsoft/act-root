# [@rotorsoft/act-notify-v1.0.1](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-notify-v1.0.0...@rotorsoft/act-notify-v1.0.1) (2026-11-10)

# [@rotorsoft/act-notify-v1.0.0](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-notify-v0.3.2...@rotorsoft/act-notify-v1.0.0) (2026-11-07)


* feat(act)!: commit(appends, meta) appends to several streams atomically ([#2304](https://github.com/Rotorsoft/act-root/issues/2304)) ([efebf3f](https://github.com/Rotorsoft/act-root/commit/efebf3fe117c3030059689c8786cb8ea4f806cf6)), closes [#2183](https://github.com/Rotorsoft/act-root/issues/2183)


### BREAKING CHANGES

* `.given(rules)` is gone; write it as `.requires(rules)`
with `valid: (state, actor)` becoming `holds: (_, state, actor)`, and type
a shared rule `Precondition<S, unknown>` instead of `Invariant<S>`. Catch
`PreconditionError` instead of `InvariantError` (`Errors.InvariantError`
and act-http's `INVARIANT` code are gone). Remove `validateFoldedState`
from `act().build(...)`. act-diagram's `ActionNode.invariants` is gone;
read `preconditions`.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(act-sqlite): run the store's statements one at a time, so concurrent calls wait, not fail

One SqliteStore owns one libSQL connection, and a second statement while
a write transaction is open on it failed at once: TRANSACTION_ACTIVE in
memory, SQLITE_BUSY on a file. Two requests committing together, or a
commit beside the drain's claim, refused one of them. Every statement and
transaction now takes its turn in an in-process queue; a query's row
callback runs outside it, so a callback that writes can't wait on itself.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* feat(act)!: commit(writes, meta) commits to several streams atomically

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* refactor(act)!: name each part of a commit an Append, and the argument appends

A commit appends events to streams, so the per-stream item is an
Append and the argument is `appends`: `commit(appends, meta)`. The
store's error messages say "the append to" and "is named twice".
* Store.commit takes `(appends: Append[], meta)`; the
type 1.x callers never saw as StreamWrite is now Append.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

# [@rotorsoft/act-notify-v0.3.2](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-notify-v0.3.1...@rotorsoft/act-notify-v0.3.2) (2026-10-26)


### Bug Fixes

* **deps:** update non-major dependencies ([#2148](https://github.com/Rotorsoft/act-root/issues/2148)) ([29b98cf](https://github.com/Rotorsoft/act-root/commit/29b98cfb7b4363073f94d2511100dc8592790006))

# [@rotorsoft/act-notify-v0.3.1](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-notify-v0.3.0...@rotorsoft/act-notify-v0.3.1) (2026-10-19)


### Bug Fixes

* **deps:** update dependency zod to ^4.6.7 ([#1983](https://github.com/Rotorsoft/act-root/issues/1983)) ([661670a](https://github.com/Rotorsoft/act-root/commit/661670ab2ff086a632d7118d24294dc26d6c883e))

# [@rotorsoft/act-notify-v0.3.0](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-notify-v0.2.4...@rotorsoft/act-notify-v0.3.0) (2026-10-18)


### Features

* **act:** reactions settle on their own, and one layering pattern for the package ([#1959](https://github.com/Rotorsoft/act-root/issues/1959)) ([9ed7599](https://github.com/Rotorsoft/act-root/commit/9ed75991ad892d26eae62c802374f296cae186f0)), closes [#1942](https://github.com/Rotorsoft/act-root/issues/1942) [#1949](https://github.com/Rotorsoft/act-root/issues/1949)

# [@rotorsoft/act-notify-v0.2.4](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-notify-v0.2.3...@rotorsoft/act-notify-v0.2.4) (2026-10-13)

# [@rotorsoft/act-notify-v0.2.3](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-notify-v0.2.2...@rotorsoft/act-notify-v0.2.3) (2026-10-06)


### Bug Fixes

* **act-notify:** never let a stalled broker hold up build or shutdown ([#1757](https://github.com/Rotorsoft/act-root/issues/1757)) ([f6d99fb](https://github.com/Rotorsoft/act-root/commit/f6d99fb0615a08d48b03d75899eef4c9dbcca1b0)), closes [#1743](https://github.com/Rotorsoft/act-root/issues/1743)
* **act-notify:** validate and contain broker notifications like Postgres does ([#1763](https://github.com/Rotorsoft/act-root/issues/1763)) ([9f87512](https://github.com/Rotorsoft/act-root/commit/9f87512c5074cf03b799aa15f0d7185365130ad4)), closes [#1748](https://github.com/Rotorsoft/act-root/issues/1748) [#1749](https://github.com/Rotorsoft/act-root/issues/1749) [#1748](https://github.com/Rotorsoft/act-root/issues/1748) [#1749](https://github.com/Rotorsoft/act-root/issues/1749)

# [@rotorsoft/act-notify-v0.2.2](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-notify-v0.2.1...@rotorsoft/act-notify-v0.2.2) (2026-09-29)


### Bug Fixes

* **deps:** update zod to ^4.6.5 ([#1692](https://github.com/Rotorsoft/act-root/issues/1692)) ([efb77a5](https://github.com/Rotorsoft/act-root/commit/efb77a50aa819f1e7a8789133bac4ac4f4db8067)), closes [#1688](https://github.com/Rotorsoft/act-root/issues/1688) [#1689](https://github.com/Rotorsoft/act-root/issues/1689) [#1691](https://github.com/Rotorsoft/act-root/issues/1691) [#1689](https://github.com/Rotorsoft/act-root/issues/1689) [#1688](https://github.com/Rotorsoft/act-root/issues/1688)

# [@rotorsoft/act-notify-v0.2.1](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-notify-v0.2.0...@rotorsoft/act-notify-v0.2.1) (2026-09-28)


### Bug Fixes

* **deps:** update non-major dependencies ([#1687](https://github.com/Rotorsoft/act-root/issues/1687)) ([98850f6](https://github.com/Rotorsoft/act-root/commit/98850f629d25a2cd91afafb30db8ef7e3bf5ba4c))

# [@rotorsoft/act-notify-v0.2.0](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-notify-v0.1.5...@rotorsoft/act-notify-v0.2.0) (2026-08-22)


### Features

* **act:** one worker reads the event log for all of them ([#1537](https://github.com/Rotorsoft/act-root/issues/1537)) ([6cb58f3](https://github.com/Rotorsoft/act-root/commit/6cb58f35dcee98ce1c96053bc73fcb54e111d986))

# [@rotorsoft/act-notify-v0.1.5](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-notify-v0.1.4...@rotorsoft/act-notify-v0.1.5) (2026-08-18)


### Bug Fixes

* **act:** match GitHub's owner casing in repository.url ([a719f54](https://github.com/Rotorsoft/act-root/commit/a719f548acb22cd303a229a4c4dafbf8f8e4f5b7))

# [@rotorsoft/act-notify-v0.1.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-notify-v0.1.3...@rotorsoft/act-notify-v0.1.4) (2026-08-03)


### Bug Fixes

* **deps:** update non-major dependencies ([f3b63d9](https://github.com/rotorsoft/act-root/commit/f3b63d98d9b9e262765700c503d55eec28c290cd))

# [@rotorsoft/act-notify-v0.1.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-notify-v0.1.2...@rotorsoft/act-notify-v0.1.3) (2026-07-21)


### Bug Fixes

* **act-notify:** don't await the broker hint-publish on the commit path ([457dc2a](https://github.com/rotorsoft/act-root/commit/457dc2a83fc48c61c4676d7ed298f3f540335632)), closes [#1311](https://github.com/rotorsoft/act-root/issues/1311)

# [@rotorsoft/act-notify-v0.1.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-notify-v0.1.1...@rotorsoft/act-notify-v0.1.2) (2026-07-18)


### Bug Fixes

* **act-notify:** unsubscribe only the disposing listener on a shared broker ([#1279](https://github.com/rotorsoft/act-root/issues/1279)) ([e1be8ef](https://github.com/rotorsoft/act-root/commit/e1be8efaa557309d42e65cd87c9703b6d16b37ad))

# [@rotorsoft/act-notify-v0.1.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-notify-v0.1.0...@rotorsoft/act-notify-v0.1.1) (2026-07-11)


### Bug Fixes

* **act:** restore regex claim sources with a literal fast-path ([3abd00d](https://github.com/rotorsoft/act-root/commit/3abd00d53848948aa0d7a59a4884a47a0e6000eb)), closes [#1215](https://github.com/rotorsoft/act-root/issues/1215) [#1215](https://github.com/rotorsoft/act-root/issues/1215)

# [@rotorsoft/act-notify-v0.1.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-notify-v0.0.0...@rotorsoft/act-notify-v0.1.0) (2026-07-08)


### Features

* **act-notify:** hybrid notify-broker decorator — ride redis for wakeups ([f5a9300](https://github.com/rotorsoft/act-root/commit/f5a930060a3a08c09167b5b3e18ddd6708e8db06)), closes [#987](https://github.com/rotorsoft/act-root/issues/987)

# Changelog
