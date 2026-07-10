# [@rotorsoft/act-sqlite-v1.12.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.12.0...@rotorsoft/act-sqlite-v1.12.1) (2026-07-10)


### Bug Fixes

* **act-sqlite:** treat claim sources as exact stream names ([4eaa407](https://github.com/rotorsoft/act-root/commit/4eaa407b48016ee7d5f42587f077d2b50bd8a132))

# [@rotorsoft/act-sqlite-v1.12.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.11.0...@rotorsoft/act-sqlite-v1.12.0) (2026-07-10)


### Features

* **act-sqlite:** windowed truncate boundary ([b65ca03](https://github.com/rotorsoft/act-root/commit/b65ca0344ca0fba86e90ab26fc4ed3869bf01de9)), closes [#1011](https://github.com/rotorsoft/act-root/issues/1011)

# [@rotorsoft/act-sqlite-v1.11.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.10.2...@rotorsoft/act-sqlite-v1.11.0) (2026-07-06)


### Features

* **act-pg:** seed-sync is the schema story — pin the contract, harden concurrent boot ([893d620](https://github.com/rotorsoft/act-root/commit/893d620be5ead475f236285a28df17f52e34107c))

# [@rotorsoft/act-sqlite-v1.10.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.10.1...@rotorsoft/act-sqlite-v1.10.2) (2026-07-05)


### Bug Fixes

* **act:** finalize drain cycles atomically — acks and defer schedules in one store call ([9ab2f26](https://github.com/rotorsoft/act-root/commit/9ab2f26e13999b1f8717984cd5bc088b919969e6))

# [@rotorsoft/act-sqlite-v1.10.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.10.0...@rotorsoft/act-sqlite-v1.10.1) (2026-07-04)


### Bug Fixes

* **act-sqlite:** throw on non-portable stream filter patterns ([#1114](https://github.com/rotorsoft/act-root/issues/1114)) ([14dad8b](https://github.com/rotorsoft/act-root/commit/14dad8be006d25badef426246a6ea1a2126fb5e4))

# [@rotorsoft/act-sqlite-v1.10.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.9.1...@rotorsoft/act-sqlite-v1.10.0) (2026-07-01)


### Bug Fixes

* **act:** run autoclose on a synthetic stream; clamp long defer timers ([#1090](https://github.com/rotorsoft/act-root/issues/1090)) ([d93bfbb](https://github.com/rotorsoft/act-root/commit/d93bfbb67d1ec4ef4245bbc642fdce22c6d0c07e))


### Features

* **act:** add persisted defer outcome + Store.defer (slice 1a-1c, [#1090](https://github.com/rotorsoft/act-root/issues/1090)) ([c5c46ce](https://github.com/rotorsoft/act-root/commit/c5c46cef7a03c2853434b9e289315d91d2165c59))
* **act:** port autocloses to a synthesized defer/close reaction (slice 1d part 2, [#1090](https://github.com/rotorsoft/act-root/issues/1090)) ([832844a](https://github.com/rotorsoft/act-root/commit/832844a1dffb3ec28fe426de1e1de4c0af8c7267))

# [@rotorsoft/act-sqlite-v1.9.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.9.0...@rotorsoft/act-sqlite-v1.9.1) (2026-06-29)


### Bug Fixes

* **deps:** update non-major dependencies ([#1098](https://github.com/rotorsoft/act-root/issues/1098)) ([1d9d491](https://github.com/rotorsoft/act-root/commit/1d9d49111f86d74d79078355bb3f756ccc730e73))

# [@rotorsoft/act-sqlite-v1.9.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.8.0...@rotorsoft/act-sqlite-v1.9.0) (2026-06-27)


### Features

* **act:** resume with_snaps reads from the latest snapshot per stream ([959f4a8](https://github.com/rotorsoft/act-root/commit/959f4a89e8213f7e71a408bdb82b2863cbca2cdd))

# [@rotorsoft/act-sqlite-v1.8.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.7.0...@rotorsoft/act-sqlite-v1.8.0) (2026-06-24)


### Features

* **act:** bound the autoclose cycle with a paginated rolling sweep ([4261a81](https://github.com/rotorsoft/act-root/commit/4261a81571ea5648486a17383d633df31ff6fed5))

# [@rotorsoft/act-sqlite-v1.7.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.6.0...@rotorsoft/act-sqlite-v1.7.0) (2026-06-22)


### Features

* **act:** add StoreError and orchestrator circuit breaker for store failures ([71852c6](https://github.com/rotorsoft/act-root/commit/71852c6be437a64af3df49adcc582e0d7c3d7147)), closes [#984](https://github.com/rotorsoft/act-root/issues/984)

# [@rotorsoft/act-sqlite-v1.6.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.5.3...@rotorsoft/act-sqlite-v1.6.0) (2026-06-20)


### Features

* **act-tck:** run store property + concurrency contracts on durable adapters ([f5c9412](https://github.com/rotorsoft/act-root/commit/f5c9412e487a4be6be5fae551b7cdab13b28062d)), closes [#982](https://github.com/rotorsoft/act-root/issues/982)

# [@rotorsoft/act-sqlite-v1.5.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.5.2...@rotorsoft/act-sqlite-v1.5.3) (2026-06-20)


### Bug Fixes

* **act-tck:** pin claim() lease semantics and align pg/sqlite adapters ([86f940e](https://github.com/rotorsoft/act-root/commit/86f940e14112afa9def0876878cfc3d46562ca7b)), closes [#980](https://github.com/rotorsoft/act-root/issues/980)

# [@rotorsoft/act-sqlite-v1.5.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.5.1...@rotorsoft/act-sqlite-v1.5.2) (2026-06-18)


### Bug Fixes

* **deps:** update dependency @libsql/client to ^0.17.4 ([#971](https://github.com/rotorsoft/act-root/issues/971)) ([ab530de](https://github.com/rotorsoft/act-root/commit/ab530de87e980831b8f61a6fe60c7dc8cf0604cd))

# [@rotorsoft/act-sqlite-v1.5.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.5.0...@rotorsoft/act-sqlite-v1.5.1) (2026-06-11)


### Bug Fixes

* **act-pg,act-sqlite,calculator:** stackblitz-installable workspace deps ([20e1e2f](https://github.com/rotorsoft/act-root/commit/20e1e2f4fbf6e0b98f44beae250f18a09515d1c8))

# [@rotorsoft/act-sqlite-v1.5.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.4.2...@rotorsoft/act-sqlite-v1.5.0) (2026-06-10)


### Features

* **act-pg,act-sqlite:** [#921](https://github.com/rotorsoft/act-root/issues/921) — adapter-layer PII column encryption via @rotorsoft/act-crypto ([e0b1109](https://github.com/rotorsoft/act-root/commit/e0b11099a4fe2f333f3a2b045df1cf6728854e71))

# [@rotorsoft/act-sqlite-v1.4.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.4.1...@rotorsoft/act-sqlite-v1.4.2) (2026-06-07)

# [@rotorsoft/act-sqlite-v1.4.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.4.0...@rotorsoft/act-sqlite-v1.4.1) (2026-06-07)

# [@rotorsoft/act-sqlite-v1.4.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.3.0...@rotorsoft/act-sqlite-v1.4.0) (2026-05-30)


### Features

* **inspector:** restore wizard, csv viewer, dry-run preview modal ([3809025](https://github.com/rotorsoft/act-root/commit/3809025f75e79846c23e2f8da49a1a68afdeb8d1)), closes [#785](https://github.com/rotorsoft/act-root/issues/785)

# [@rotorsoft/act-sqlite-v1.3.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.2.0...@rotorsoft/act-sqlite-v1.3.0) (2026-05-28)


### Features

* **act:** eventsource/eventsink interfaces + csvfile + backpressured iterate util ([738f0eb](https://github.com/rotorsoft/act-root/commit/738f0eb49944b30de0363ecf406da91bbfa069f8)), closes [#788](https://github.com/rotorsoft/act-root/issues/788) [#814](https://github.com/rotorsoft/act-root/issues/814) [#784](https://github.com/rotorsoft/act-root/issues/784) [#814](https://github.com/rotorsoft/act-root/issues/814)

# [@rotorsoft/act-sqlite-v1.2.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.1.0...@rotorsoft/act-sqlite-v1.2.0) (2026-05-26)


### Features

* **act:** restoreoptions compaction + dry-run + progress (ACT-1125) ([51164c6](https://github.com/rotorsoft/act-root/commit/51164c6c8c33e8f4dac192d0d5c0a1120340e0b1)), closes [#783](https://github.com/rotorsoft/act-root/issues/783) [#783](https://github.com/rotorsoft/act-root/issues/783) [#783](https://github.com/rotorsoft/act-root/issues/783) [#783](https://github.com/rotorsoft/act-root/issues/783) [#784](https://github.com/rotorsoft/act-root/issues/784)

# [@rotorsoft/act-sqlite-v1.1.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.0.1...@rotorsoft/act-sqlite-v1.1.0) (2026-05-25)


### Features

* **act:** store.restore port method + tck + adapter impls (ACT-1124) ([104db4b](https://github.com/rotorsoft/act-root/commit/104db4bd18389f2e14e6be96337ed9aa62b6318a)), closes [#786](https://github.com/rotorsoft/act-root/issues/786) [#784](https://github.com/rotorsoft/act-root/issues/784) [#785](https://github.com/rotorsoft/act-root/issues/785) [#784](https://github.com/rotorsoft/act-root/issues/784) [#784](https://github.com/rotorsoft/act-root/issues/784) [#789](https://github.com/rotorsoft/act-root/issues/789) [#802](https://github.com/rotorsoft/act-root/issues/802) [#783](https://github.com/rotorsoft/act-root/issues/783)

# [@rotorsoft/act-sqlite-v1.0.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.0.0...@rotorsoft/act-sqlite-v1.0.1) (2026-05-21)


### Bug Fixes

* **act-sqlite:** re-cut the 1.0 line as 1.0.1 after npm reserved 1.0.0 ([3d2ae10](https://github.com/rotorsoft/act-root/commit/3d2ae10a7dd450f032e20db8e3fce731712d9aa2)), closes [#702](https://github.com/rotorsoft/act-root/issues/702)

# [@rotorsoft/act-sqlite-v1.0.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.9.0...@rotorsoft/act-sqlite-v1.0.0) (2026-05-21)


* chore(act-sqlite)!: enter 1.0 stability commitment ([1fc2846](https://github.com/rotorsoft/act-root/commit/1fc28466925d7c464877f0d413fbb80dd0f10af4)), closes [#702](https://github.com/rotorsoft/act-root/issues/702)


### BREAKING CHANGES

* This is the 1.0 release of @rotorsoft/act-sqlite. It
implements the Store contract from @rotorsoft/act 1.0 and is validated
against @rotorsoft/act-tck on @libsql/client pinned + latest in CI.
Per STABILITY.md, breaking changes to the published surface now
require a major bump.

# [@rotorsoft/act-sqlite-v0.9.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.8.0...@rotorsoft/act-sqlite-v0.9.0) (2026-05-19)


### Features

* **act-sqlite:** wire lanes through SqliteStore and consolidate the lane contract into the TCK ([70c062b](https://github.com/rotorsoft/act-root/commit/70c062b256b273982ca9e6d155a8606020fd35e4))
* **act:** per-lane DrainController fan-out in the orchestrator ([71612ee](https://github.com/rotorsoft/act-root/commit/71612ee56ab094a57ce05de086c7a13f6be75841))

# [@rotorsoft/act-sqlite-v0.9.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.8.0...@rotorsoft/act-sqlite-v0.9.0) (2026-05-19)


### Features

* **act-sqlite:** wire lanes through SqliteStore and consolidate the lane contract into the TCK ([70c062b](https://github.com/rotorsoft/act-root/commit/70c062b256b273982ca9e6d155a8606020fd35e4))
* **act:** per-lane DrainController fan-out in the orchestrator ([71612ee](https://github.com/rotorsoft/act-root/commit/71612ee56ab094a57ce05de086c7a13f6be75841))

# [@rotorsoft/act-sqlite-v0.8.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.7.0...@rotorsoft/act-sqlite-v0.8.0) (2026-05-17)


### Features

* **act:** add Store.query_stats — batched per-stream aggregates ([#752](https://github.com/rotorsoft/act-root/issues/752)) ([fb1cbbc](https://github.com/rotorsoft/act-root/commit/fb1cbbcb99d02fd20bb3a6fa54ae48822f09c439)), closes [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#708](https://github.com/rotorsoft/act-root/issues/708) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#708](https://github.com/rotorsoft/act-root/issues/708) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639)

# [@rotorsoft/act-sqlite-v0.7.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.6.0...@rotorsoft/act-sqlite-v0.7.0) (2026-05-16)


### Features

* **act:** add app.unblock for poison-message recovery ([0374df8](https://github.com/rotorsoft/act-root/commit/0374df897143ead2d9b0251e973e24249bc29db7))
* **act:** reset and unblock accept string[] or StreamFilter; add app.blocked_streams ([1cd4e98](https://github.com/rotorsoft/act-root/commit/1cd4e9889c0dd934b81fdfb660c5d8cf4cc96803))


### BREAKING CHANGES

* **act:** for adapters that don't implement it yet; capability-
gated in the TCK). Implemented across all three in-tree adapters:

- InMemoryStore: new InMemoryStream.unblock() that flips _blocked and
  returns whether the stream was actually flipped.
- PostgresStore: single UPDATE with WHERE blocked = true so rowCount
  reflects only streams that flipped.
- SqliteStore: transactional UPDATE per stream, mirrors the PG semantics.

All three set retry = -1 (matching the InMemoryStore convention) so the
first post-unblock claim returns retry = 0 ("first attempt"). Storing 0
would make claim's post-bump return 1, mis-reporting the post-recovery
attempt as a continuation of the failed sequence.

Adds Act.unblock(streams) that wraps store().unblock() and arms the
orchestrator's drain flag so a settled app picks up the now-free streams
on the next cycle. Symmetric with the existing Act.reset() wrapper.

TCK: new "unblock" describe block with four cases — happy path
(blocked → unblock → claim resumes at preserved watermark, retry = 0),
no-op on unblocked stream, no-op on unknown/empty, mixed input counts
only the actually-blocked streams.

Integration test in non-retryable.spec.ts exercises the full
NonRetryableError → block → unblock → reprocess flow: handler throws
permanent error, drain blocks immediately, app.unblock(streams) clears
the flag, next drain succeeds at the SAME event (not replayed from
zero).

Docs:
- docs/concepts/error-handling.md gains an "unblock" subsection
  contrasting it with reset.
- docs/architecture/concurrency-model.md's "block" exit description
  updated to mention NonRetryableError and the unblock/reset choice.
- docs/guides/production-checklist.md changes the recovery instruction
  from "Unblock with app.reset" to "recover with app.unblock; reset is
  for rebuilds."
- libs/act-http/README.md adds a "Recovering a blocked stream"
  subsection — important because 4xx blocks are now the common case
  and reset would re-fire all historical webhooks.
- book/act-604-non-retryable.md gains a section on the recovery
  primitive, including the retry = -1 convention rationale.

Tests: 1556 passed (3 new unblock tests in TCK, 2 new in non-retryable
spec). Coverage 99.95% branches globally — drops from 100% are in
defensive error paths (rowCount ?? 0, rollback) that mirror the
existing untested paths in reset.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

# [@rotorsoft/act-sqlite-v0.6.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.5.2...@rotorsoft/act-sqlite-v0.6.0) (2026-05-14)


### Features

* **act-tck:** extract Store/Cache/Logger TCK package (ACT-302) ([ff9bfd4](https://github.com/rotorsoft/act-root/commit/ff9bfd44b3cf36890186c6db7965c531458953a2))

# [@rotorsoft/act-sqlite-v0.5.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.5.1...@rotorsoft/act-sqlite-v0.5.2) (2026-05-14)


### Bug Fixes

* **deps:** update dependency @rotorsoft/act to v0.39.0 ([5ca8f1f](https://github.com/rotorsoft/act-root/commit/5ca8f1f2031c72aef4b85efcb3f999285d23b5f7))

# [@rotorsoft/act-sqlite-v0.5.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.5.0...@rotorsoft/act-sqlite-v0.5.1) (2026-05-10)


### Bug Fixes

* **ci:** rebuild dist in CD instead of relying on broken artifact ([992a334](https://github.com/rotorsoft/act-root/commit/992a334fa356b98ec6dbbb34674318f77e067f78))

# [@rotorsoft/act-sqlite-v0.5.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.4.0...@rotorsoft/act-sqlite-v0.5.0) (2026-05-10)


### Bug Fixes

* unify workspace bench config + repair CI bench summary + npm keywords ([56b192c](https://github.com/rotorsoft/act-root/commit/56b192c1bd6d217a76099c7d185d0620d908edc0))


### Features

* **act:** per-stream reaction priority lanes (ACT-102) ([c08f18a](https://github.com/rotorsoft/act-root/commit/c08f18a05bbf478c4e0128dbd175897bb18dd701))

# [@rotorsoft/act-sqlite-v0.4.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.3.4...@rotorsoft/act-sqlite-v0.4.0) (2026-05-10)


### Features

* **act:** add Store.notify hook for cross-process drain wakeup (ACT-101) ([f1f40cf](https://github.com/rotorsoft/act-root/commit/f1f40cf608ba107c88bd0a0144c49af2ece47fe7))

# [@rotorsoft/act-sqlite-v0.3.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.3.3...@rotorsoft/act-sqlite-v0.3.4) (2026-05-09)


### Bug Fixes

* **builders:** split .emit() overloads + zod as peer dep ([b766671](https://github.com/rotorsoft/act-root/commit/b76667124752d9dbc5e34e1508d3628f8eb6112d))

# [@rotorsoft/act-sqlite-v0.3.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.3.2...@rotorsoft/act-sqlite-v0.3.3) (2026-05-06)


### Bug Fixes

* **deps:** update dependency zod to ^4.4.3 ([84c5bc7](https://github.com/rotorsoft/act-root/commit/84c5bc77bd55edb427f202ce43acf38878c23003))

# [@rotorsoft/act-sqlite-v0.3.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.3.1...@rotorsoft/act-sqlite-v0.3.2) (2026-05-04)


### Bug Fixes

* **deps:** update dependency zod to ^4.4.2 ([abaa2ee](https://github.com/rotorsoft/act-root/commit/abaa2ee59989073b1bdb67fa1f989e2572fddb04))

# [@rotorsoft/act-sqlite-v0.3.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.3.0...@rotorsoft/act-sqlite-v0.3.1) (2026-05-03)

# [@rotorsoft/act-sqlite-v0.3.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.2.1...@rotorsoft/act-sqlite-v0.3.0) (2026-05-02)


* fix(deps)!: declare @rotorsoft/act as peer dep in adapters ([785b7b7](https://github.com/rotorsoft/act-root/commit/785b7b71ad223e0ca10944a0cc514ecd59a714ac)), closes [#632](https://github.com/rotorsoft/act-root/issues/632) [#632](https://github.com/rotorsoft/act-root/issues/632)


### BREAKING CHANGES

* consumers of @rotorsoft/act-pg, @rotorsoft/act-sqlite,
and @rotorsoft/act-pino must explicitly declare @rotorsoft/act as a
direct dependency. In practice every consumer that uses an adapter
already imports from @rotorsoft/act directly, so this formalizes
existing reality. After upgrading to the new adapter versions a single
time, future bumps to @rotorsoft/act alone are sufficient — adapters
follow automatically via the wide peer range.

# [@rotorsoft/act-sqlite-v0.2.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.2.0...@rotorsoft/act-sqlite-v0.2.1) (2026-05-01)


### Bug Fixes

* **deps:** update dependency zod to ^4.4.1 ([de538f5](https://github.com/rotorsoft/act-root/commit/de538f5e61a43cbdcb25d07049579d4a0eab0e8a))

# [@rotorsoft/act-sqlite-v0.2.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.1.3...@rotorsoft/act-sqlite-v0.2.0) (2026-04-27)


### Features

* **act:** add Store.query_streams for subscription introspection ([508c724](https://github.com/rotorsoft/act-root/commit/508c724a4176750dea5d9356e2e8290496331e61))

# [@rotorsoft/act-sqlite-v0.1.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.1.2...@rotorsoft/act-sqlite-v0.1.3) (2026-04-27)


### Bug Fixes

* **deps:** update dependency @libsql/client to ^0.17.3 ([e88a32a](https://github.com/rotorsoft/act-root/commit/e88a32aa33e3a59885ae789ea8040d730ef96885))

# [@rotorsoft/act-sqlite-v0.1.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.1.1...@rotorsoft/act-sqlite-v0.1.2) (2026-04-27)


### Bug Fixes

* **act-sqlite:** tighten regex→LIKE stream pattern conversion ([7af3bad](https://github.com/rotorsoft/act-root/commit/7af3badb4eabeb08865e03ecb6273e327235788f))

# [@rotorsoft/act-sqlite-v0.1.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.1.0...@rotorsoft/act-sqlite-v0.1.1) (2026-04-26)


### Bug Fixes

* **act-sqlite:** reset version to 0.1.0 baseline ([c92712b](https://github.com/rotorsoft/act-root/commit/c92712b1fb89c8caf2fc836054f5549129a38063))
