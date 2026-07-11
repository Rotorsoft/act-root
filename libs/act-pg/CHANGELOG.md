# [@rotorsoft/act-pg-v1.13.5](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.13.4...@rotorsoft/act-pg-v1.13.5) (2026-07-11)


### Bug Fixes

* **act:** orphaned-lane advisory, defer durability across restart, audit lane universe ([1dee16d](https://github.com/rotorsoft/act-root/commit/1dee16d09f4aab2efaef5447ca6c7d924419dd8c))

# [@rotorsoft/act-pg-v1.13.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.13.3...@rotorsoft/act-pg-v1.13.4) (2026-07-11)


### Bug Fixes

* **act-pg:** keep the dead listen client's error handler across reconnect ([71624b8](https://github.com/rotorsoft/act-root/commit/71624b86f674cd871f11ec9e4253aeb81886055c)), closes [#1189](https://github.com/rotorsoft/act-root/issues/1189)

# [@rotorsoft/act-pg-v1.13.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.13.2...@rotorsoft/act-pg-v1.13.3) (2026-07-11)


### Bug Fixes

* **act:** restore regex claim sources with a literal fast-path ([3abd00d](https://github.com/rotorsoft/act-root/commit/3abd00d53848948aa0d7a59a4884a47a0e6000eb)), closes [#1215](https://github.com/rotorsoft/act-root/issues/1215) [#1215](https://github.com/rotorsoft/act-root/issues/1215)

# [@rotorsoft/act-pg-v1.13.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.13.1...@rotorsoft/act-pg-v1.13.2) (2026-07-10)


### Bug Fixes

* **act-pg:** self-healing LISTEN reconnect and widen streams.retry to int ([eb52460](https://github.com/rotorsoft/act-root/commit/eb524607f454ad40002c83cbdf09660309e4eed5)), closes [hi#severity](https://github.com/hi/issues/severity) [#1189](https://github.com/rotorsoft/act-root/issues/1189) [#1190](https://github.com/rotorsoft/act-root/issues/1190)

# [@rotorsoft/act-pg-v1.13.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.13.0...@rotorsoft/act-pg-v1.13.1) (2026-07-10)


### Bug Fixes

* **act-pg:** serialize commit visibility to close the serial-id gap ([b3feaac](https://github.com/rotorsoft/act-root/commit/b3feaac923f379697986092a2e185dd3746f2c09)), closes [#1178](https://github.com/rotorsoft/act-root/issues/1178)


### Performance Improvements

* **act-pg:** shrink the commit visibility-lock window ([2f300a1](https://github.com/rotorsoft/act-root/commit/2f300a1ebfeb56faa26f8ff86b255668a7afe799)), closes [#1178](https://github.com/rotorsoft/act-root/issues/1178)
* **act-pg:** single-statement commit makes the visibility lock free ([f911e65](https://github.com/rotorsoft/act-root/commit/f911e65ed78cf1c0f4dd3dd4a0c9fb450316dc3a)), closes [#1178](https://github.com/rotorsoft/act-root/issues/1178)

# [@rotorsoft/act-pg-v1.13.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.12.0...@rotorsoft/act-pg-v1.13.0) (2026-07-10)


### Features

* **act-pg:** windowed truncate boundary ([796006e](https://github.com/rotorsoft/act-root/commit/796006e6661cb80e2237a22f012afd6182e51cc0)), closes [#1011](https://github.com/rotorsoft/act-root/issues/1011)

# [@rotorsoft/act-pg-v1.12.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.11.0...@rotorsoft/act-pg-v1.12.0) (2026-07-08)


### Features

* **act:** state projections — projection(name).of(state).flush(handler) ([a5ef582](https://github.com/rotorsoft/act-root/commit/a5ef5827a5e64049f369883e6326790f46d71208)), closes [#1125](https://github.com/rotorsoft/act-root/issues/1125)

# [@rotorsoft/act-pg-v1.11.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.10.2...@rotorsoft/act-pg-v1.11.0) (2026-07-06)


### Features

* **act-pg:** seed-sync is the schema story — pin the contract, harden concurrent boot ([893d620](https://github.com/rotorsoft/act-root/commit/893d620be5ead475f236285a28df17f52e34107c))

# [@rotorsoft/act-pg-v1.10.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.10.1...@rotorsoft/act-pg-v1.10.2) (2026-07-05)


### Bug Fixes

* **act:** finalize drain cycles atomically — acks and defer schedules in one store call ([9ab2f26](https://github.com/rotorsoft/act-root/commit/9ab2f26e13999b1f8717984cd5bc088b919969e6))

# [@rotorsoft/act-pg-v1.10.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.10.0...@rotorsoft/act-pg-v1.10.1) (2026-07-04)


### Bug Fixes

* **act-pg:** opinionated pool defaults and clear acquisition errors ([#1119](https://github.com/rotorsoft/act-root/issues/1119)) ([c1acdb5](https://github.com/rotorsoft/act-root/commit/c1acdb5c0d1489dfc1f4faa69bc413a06d06a32f))
* **act-pg:** skip oversize notify payloads so commits never abort ([#1120](https://github.com/rotorsoft/act-root/issues/1120)) ([982a224](https://github.com/rotorsoft/act-root/commit/982a224a3f8ce2811b783570b33f69154087e43a))

# [@rotorsoft/act-pg-v1.10.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.9.3...@rotorsoft/act-pg-v1.10.0) (2026-07-01)


### Features

* **act:** add persisted defer outcome + Store.defer (slice 1a-1c, [#1090](https://github.com/rotorsoft/act-root/issues/1090)) ([c5c46ce](https://github.com/rotorsoft/act-root/commit/c5c46cef7a03c2853434b9e289315d91d2165c59))
* **act:** port autocloses to a synthesized defer/close reaction (slice 1d part 2, [#1090](https://github.com/rotorsoft/act-root/issues/1090)) ([832844a](https://github.com/rotorsoft/act-root/commit/832844a1dffb3ec28fe426de1e1de4c0af8c7267))

# [@rotorsoft/act-pg-v1.9.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.9.2...@rotorsoft/act-pg-v1.9.3) (2026-06-29)


### Bug Fixes

* **deps:** update non-major dependencies ([d948723](https://github.com/rotorsoft/act-root/commit/d948723bea8eb6f6454338c300f68a234cf17bf8))

# [@rotorsoft/act-pg-v1.9.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.9.1...@rotorsoft/act-pg-v1.9.2) (2026-06-29)


### Bug Fixes

* **deps:** update non-major dependencies ([#1098](https://github.com/rotorsoft/act-root/issues/1098)) ([1d9d491](https://github.com/rotorsoft/act-root/commit/1d9d49111f86d74d79078355bb3f756ccc730e73))

# [@rotorsoft/act-pg-v1.9.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.9.0...@rotorsoft/act-pg-v1.9.1) (2026-06-28)


### Bug Fixes

* **act-pg:** stop the perf-bench notify scenario from hanging ([f3d1e3c](https://github.com/rotorsoft/act-root/commit/f3d1e3c08e1c5bb53312d5481409fa22e2df5941)), closes [#1031](https://github.com/rotorsoft/act-root/issues/1031)

# [@rotorsoft/act-pg-v1.9.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.8.0...@rotorsoft/act-pg-v1.9.0) (2026-06-27)


### Features

* **act:** resume with_snaps reads from the latest snapshot per stream ([959f4a8](https://github.com/rotorsoft/act-root/commit/959f4a89e8213f7e71a408bdb82b2863cbca2cdd))

# [@rotorsoft/act-pg-v1.8.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.7.0...@rotorsoft/act-pg-v1.8.0) (2026-06-24)


### Features

* **act:** bound the autoclose cycle with a paginated rolling sweep ([4261a81](https://github.com/rotorsoft/act-root/commit/4261a81571ea5648486a17383d633df31ff6fed5))

# [@rotorsoft/act-pg-v1.7.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.6.0...@rotorsoft/act-pg-v1.7.0) (2026-06-22)


### Features

* **act:** add StoreError and orchestrator circuit breaker for store failures ([71852c6](https://github.com/rotorsoft/act-root/commit/71852c6be437a64af3df49adcc582e0d7c3d7147)), closes [#984](https://github.com/rotorsoft/act-root/issues/984)

# [@rotorsoft/act-pg-v1.6.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.5.2...@rotorsoft/act-pg-v1.6.0) (2026-06-20)


### Features

* **act-tck:** run store property + concurrency contracts on durable adapters ([f5c9412](https://github.com/rotorsoft/act-root/commit/f5c9412e487a4be6be5fae551b7cdab13b28062d)), closes [#982](https://github.com/rotorsoft/act-root/issues/982)

# [@rotorsoft/act-pg-v1.5.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.5.1...@rotorsoft/act-pg-v1.5.2) (2026-06-20)


### Bug Fixes

* **act-tck:** pin claim() lease semantics and align pg/sqlite adapters ([86f940e](https://github.com/rotorsoft/act-root/commit/86f940e14112afa9def0876878cfc3d46562ca7b)), closes [#980](https://github.com/rotorsoft/act-root/issues/980)

# [@rotorsoft/act-pg-v1.5.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.5.0...@rotorsoft/act-pg-v1.5.1) (2026-06-11)


### Bug Fixes

* **act-pg,act-sqlite,calculator:** stackblitz-installable workspace deps ([20e1e2f](https://github.com/rotorsoft/act-root/commit/20e1e2f4fbf6e0b98f44beae250f18a09515d1c8))

# [@rotorsoft/act-pg-v1.5.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.4.3...@rotorsoft/act-pg-v1.5.0) (2026-06-10)


### Features

* **act-pg,act-sqlite:** [#921](https://github.com/rotorsoft/act-root/issues/921) — adapter-layer PII column encryption via @rotorsoft/act-crypto ([e0b1109](https://github.com/rotorsoft/act-root/commit/e0b11099a4fe2f333f3a2b045df1cf6728854e71))

# [@rotorsoft/act-pg-v1.4.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.4.2...@rotorsoft/act-pg-v1.4.3) (2026-06-09)

# [@rotorsoft/act-pg-v1.4.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.4.1...@rotorsoft/act-pg-v1.4.2) (2026-06-07)

# [@rotorsoft/act-pg-v1.4.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.4.0...@rotorsoft/act-pg-v1.4.1) (2026-06-07)

# [@rotorsoft/act-pg-v1.4.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.3.0...@rotorsoft/act-pg-v1.4.0) (2026-05-30)


### Features

* **act:** batch_size + max_id probe for determinate progress (ACT-1133) ([ab78103](https://github.com/rotorsoft/act-root/commit/ab78103cbc674918413752c531f5ccaee83ebe53))
* **act:** iterate paginates source.query for bounded-memory scan (ACT-1133) ([f97b103](https://github.com/rotorsoft/act-root/commit/f97b10343b7a47b08468ac9169e13db09c5a3f90)), closes [#817](https://github.com/rotorsoft/act-root/issues/817)

# [@rotorsoft/act-pg-v1.3.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.2.0...@rotorsoft/act-pg-v1.3.0) (2026-05-28)


### Features

* **act:** eventsource/eventsink interfaces + csvfile + backpressured iterate util ([738f0eb](https://github.com/rotorsoft/act-root/commit/738f0eb49944b30de0363ecf406da91bbfa069f8)), closes [#788](https://github.com/rotorsoft/act-root/issues/788) [#814](https://github.com/rotorsoft/act-root/issues/814) [#784](https://github.com/rotorsoft/act-root/issues/784) [#814](https://github.com/rotorsoft/act-root/issues/814)

# [@rotorsoft/act-pg-v1.2.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.1.0...@rotorsoft/act-pg-v1.2.0) (2026-05-26)


### Features

* **act:** restoreoptions compaction + dry-run + progress (ACT-1125) ([51164c6](https://github.com/rotorsoft/act-root/commit/51164c6c8c33e8f4dac192d0d5c0a1120340e0b1)), closes [#783](https://github.com/rotorsoft/act-root/issues/783) [#783](https://github.com/rotorsoft/act-root/issues/783) [#783](https://github.com/rotorsoft/act-root/issues/783) [#783](https://github.com/rotorsoft/act-root/issues/783) [#784](https://github.com/rotorsoft/act-root/issues/784)

# [@rotorsoft/act-pg-v1.1.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.0.1...@rotorsoft/act-pg-v1.1.0) (2026-05-25)


### Features

* **act:** store.restore port method + tck + adapter impls (ACT-1124) ([104db4b](https://github.com/rotorsoft/act-root/commit/104db4bd18389f2e14e6be96337ed9aa62b6318a)), closes [#786](https://github.com/rotorsoft/act-root/issues/786) [#784](https://github.com/rotorsoft/act-root/issues/784) [#785](https://github.com/rotorsoft/act-root/issues/785) [#784](https://github.com/rotorsoft/act-root/issues/784) [#784](https://github.com/rotorsoft/act-root/issues/784) [#789](https://github.com/rotorsoft/act-root/issues/789) [#802](https://github.com/rotorsoft/act-root/issues/802) [#783](https://github.com/rotorsoft/act-root/issues/783)

# [@rotorsoft/act-pg-v1.0.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v1.0.0...@rotorsoft/act-pg-v1.0.1) (2026-05-24)


### Bug Fixes

* **deps:** update dependency pg to ^8.21.0 ([35df7b0](https://github.com/rotorsoft/act-root/commit/35df7b094f2c0b758c222afcef54eef642783d1a))

# [@rotorsoft/act-pg-v1.0.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.25.0...@rotorsoft/act-pg-v1.0.0) (2026-05-21)


* chore(act-pg)!: enter 1.0 stability commitment ([cc4388e](https://github.com/rotorsoft/act-root/commit/cc4388e791c0a6c8cb25a2b395729f26695515cc)), closes [#702](https://github.com/rotorsoft/act-root/issues/702)


### BREAKING CHANGES

* This is the 1.0 release of @rotorsoft/act-pg. It
implements the Store contract from @rotorsoft/act 1.0 and is validated
against @rotorsoft/act-tck across PostgreSQL 14/15/16/17 in CI. Per
STABILITY.md, breaking changes to the published surface now require a
major bump.

# [@rotorsoft/act-pg-v0.25.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.24.0...@rotorsoft/act-pg-v0.25.0) (2026-05-19)


### Features

* **act-pg:** wire lanes through PostgresStore ([52ee53f](https://github.com/rotorsoft/act-root/commit/52ee53f805112dd7d5b5d12fd3581cd9bd484604))
* **act-sqlite:** wire lanes through SqliteStore and consolidate the lane contract into the TCK ([70c062b](https://github.com/rotorsoft/act-root/commit/70c062b256b273982ca9e6d155a8606020fd35e4))
* **act:** human-readable drain traces + lane suffix; lane on ack/block ([82fc17a](https://github.com/rotorsoft/act-root/commit/82fc17aea2f7eeef21be3ba1c387aac4591cd603)), closes [#id](https://github.com/rotorsoft/act-root/issues/id) [#id](https://github.com/rotorsoft/act-root/issues/id)
* **act:** parallel lane drain + per-lane workers; PG benchmark headline ([f76bc31](https://github.com/rotorsoft/act-root/commit/f76bc3146b0943c71d57992c8b270c85ed5e4eb1))
* **act:** per-lane DrainController fan-out in the orchestrator ([71612ee](https://github.com/rotorsoft/act-root/commit/71612ee56ab094a57ce05de086c7a13f6be75841))

# [@rotorsoft/act-pg-v0.25.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.24.0...@rotorsoft/act-pg-v0.25.0) (2026-05-19)


### Features

* **act-pg:** wire lanes through PostgresStore ([52ee53f](https://github.com/rotorsoft/act-root/commit/52ee53f805112dd7d5b5d12fd3581cd9bd484604))
* **act-sqlite:** wire lanes through SqliteStore and consolidate the lane contract into the TCK ([70c062b](https://github.com/rotorsoft/act-root/commit/70c062b256b273982ca9e6d155a8606020fd35e4))
* **act:** human-readable drain traces + lane suffix; lane on ack/block ([82fc17a](https://github.com/rotorsoft/act-root/commit/82fc17aea2f7eeef21be3ba1c387aac4591cd603)), closes [#id](https://github.com/rotorsoft/act-root/issues/id) [#id](https://github.com/rotorsoft/act-root/issues/id)
* **act:** parallel lane drain + per-lane workers; PG benchmark headline ([f76bc31](https://github.com/rotorsoft/act-root/commit/f76bc3146b0943c71d57992c8b270c85ed5e4eb1))
* **act:** per-lane DrainController fan-out in the orchestrator ([71612ee](https://github.com/rotorsoft/act-root/commit/71612ee56ab094a57ce05de086c7a13f6be75841))

# [@rotorsoft/act-pg-v0.24.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.23.0...@rotorsoft/act-pg-v0.24.0) (2026-05-17)


### Features

* **act:** add Store.query_stats — batched per-stream aggregates ([#752](https://github.com/rotorsoft/act-root/issues/752)) ([fb1cbbc](https://github.com/rotorsoft/act-root/commit/fb1cbbcb99d02fd20bb3a6fa54ae48822f09c439)), closes [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#708](https://github.com/rotorsoft/act-root/issues/708) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#708](https://github.com/rotorsoft/act-root/issues/708) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639)

# [@rotorsoft/act-pg-v0.23.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.22.0...@rotorsoft/act-pg-v0.23.0) (2026-05-16)


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

# [@rotorsoft/act-pg-v0.22.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.21.1...@rotorsoft/act-pg-v0.22.0) (2026-05-14)


### Features

* **act-tck:** extract Store/Cache/Logger TCK package (ACT-302) ([ff9bfd4](https://github.com/rotorsoft/act-root/commit/ff9bfd44b3cf36890186c6db7965c531458953a2))

# [@rotorsoft/act-pg-v0.21.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.21.0...@rotorsoft/act-pg-v0.21.1) (2026-05-14)


### Bug Fixes

* **deps:** update dependency @rotorsoft/act to v0.39.0 ([5ca8f1f](https://github.com/rotorsoft/act-root/commit/5ca8f1f2031c72aef4b85efcb3f999285d23b5f7))

# [@rotorsoft/act-pg-v0.21.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.20.2...@rotorsoft/act-pg-v0.21.0) (2026-05-12)


### Features

* **act:** test helpers — sandbox + fixture for parallel-safe per-test isolation (ACT-503) ([ea38cf5](https://github.com/rotorsoft/act-root/commit/ea38cf5136417531f5cc46313e8c4a587221958e))

# [@rotorsoft/act-pg-v0.20.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.20.1...@rotorsoft/act-pg-v0.20.2) (2026-05-10)


### Bug Fixes

* **ci:** rebuild dist in CD instead of relying on broken artifact ([992a334](https://github.com/rotorsoft/act-root/commit/992a334fa356b98ec6dbbb34674318f77e067f78))

# [@rotorsoft/act-pg-v0.20.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.20.0...@rotorsoft/act-pg-v0.20.1) (2026-05-10)


### Bug Fixes

* unify workspace bench config + repair CI bench summary + npm keywords ([56b192c](https://github.com/rotorsoft/act-root/commit/56b192c1bd6d217a76099c7d185d0620d908edc0))

# [@rotorsoft/act-pg-v0.20.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.19.0...@rotorsoft/act-pg-v0.20.0) (2026-05-10)


### Features

* **act-pg:** add PG single-process reaction latency bench (ACT-103) ([8554f57](https://github.com/rotorsoft/act-root/commit/8554f5782ef0b8905e39171e3711934a5960e03a))
* **act:** per-stream reaction priority lanes (ACT-102) ([c08f18a](https://github.com/rotorsoft/act-root/commit/c08f18a05bbf478c4e0128dbd175897bb18dd701))
* **act:** reaction latency bench + workspace bench unification (ACT-103) ([79d419d](https://github.com/rotorsoft/act-root/commit/79d419dbee73dc0fbda65599e4f687362471aecd))

# [@rotorsoft/act-pg-v0.19.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.18.6...@rotorsoft/act-pg-v0.19.0) (2026-05-10)


### Features

* **act:** add Store.notify hook for cross-process drain wakeup (ACT-101) ([f1f40cf](https://github.com/rotorsoft/act-root/commit/f1f40cf608ba107c88bd0a0144c49af2ece47fe7))

# [@rotorsoft/act-pg-v0.18.6](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.18.5...@rotorsoft/act-pg-v0.18.6) (2026-05-09)


### Bug Fixes

* **builders:** split .emit() overloads + zod as peer dep ([b766671](https://github.com/rotorsoft/act-root/commit/b76667124752d9dbc5e34e1508d3628f8eb6112d))

# [@rotorsoft/act-pg-v0.18.5](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.18.4...@rotorsoft/act-pg-v0.18.5) (2026-05-06)


### Bug Fixes

* **deps:** update dependency zod to ^4.4.3 ([84c5bc7](https://github.com/rotorsoft/act-root/commit/84c5bc77bd55edb427f202ce43acf38878c23003))

# [@rotorsoft/act-pg-v0.18.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.18.3...@rotorsoft/act-pg-v0.18.4) (2026-05-04)


### Bug Fixes

* **deps:** update dependency zod to ^4.4.2 ([abaa2ee](https://github.com/rotorsoft/act-root/commit/abaa2ee59989073b1bdb67fa1f989e2572fddb04))

# [@rotorsoft/act-pg-v0.18.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.18.2...@rotorsoft/act-pg-v0.18.3) (2026-05-03)

# [@rotorsoft/act-pg-v0.18.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.18.1...@rotorsoft/act-pg-v0.18.2) (2026-05-03)

# [@rotorsoft/act-pg-v0.18.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.18.0...@rotorsoft/act-pg-v0.18.1) (2026-05-02)


### Bug Fixes

* **act-pg:** update test bench import after src/internal move ([935c5b5](https://github.com/rotorsoft/act-root/commit/935c5b5e8e2ef1da391f5f94938c281f0bb63b68))

# [@rotorsoft/act-pg-v0.18.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.17.1...@rotorsoft/act-pg-v0.18.0) (2026-05-02)


* fix(deps)!: declare @rotorsoft/act as peer dep in adapters ([785b7b7](https://github.com/rotorsoft/act-root/commit/785b7b71ad223e0ca10944a0cc514ecd59a714ac)), closes [#632](https://github.com/rotorsoft/act-root/issues/632) [#632](https://github.com/rotorsoft/act-root/issues/632)


### BREAKING CHANGES

* consumers of @rotorsoft/act-pg, @rotorsoft/act-sqlite,
and @rotorsoft/act-pino must explicitly declare @rotorsoft/act as a
direct dependency. In practice every consumer that uses an adapter
already imports from @rotorsoft/act directly, so this formalizes
existing reality. After upgrading to the new adapter versions a single
time, future bumps to @rotorsoft/act alone are sufficient — adapters
follow automatically via the wide peer range.

# [@rotorsoft/act-pg-v0.17.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.17.0...@rotorsoft/act-pg-v0.17.1) (2026-05-01)


### Bug Fixes

* **deps:** update dependency zod to ^4.4.1 ([de538f5](https://github.com/rotorsoft/act-root/commit/de538f5e61a43cbdcb25d07049579d4a0eab0e8a))

# [@rotorsoft/act-pg-v0.17.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.16.0...@rotorsoft/act-pg-v0.17.0) (2026-04-27)


### Features

* **act:** add Store.query_streams for subscription introspection ([508c724](https://github.com/rotorsoft/act-root/commit/508c724a4176750dea5d9356e2e8290496331e61))

# [@rotorsoft/act-pg-v0.16.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.15.0...@rotorsoft/act-pg-v0.16.0) (2026-04-13)


### Bug Fixes

* **act-pg:** per-stream DELETE in loop instead of RETURNING all rows ([1d604bf](https://github.com/rotorsoft/act-root/commit/1d604bfcac5d43b74d91adf06f1836ad68856361))
* **act:** pass proper meta from close() to store.truncate() ([2dbd31a](https://github.com/rotorsoft/act-root/commit/2dbd31a50eac4189f3b011fabf9030db7d704c14))
* **act:** truncate returns committed seeds for correct cache warming ([f42fb94](https://github.com/rotorsoft/act-root/commit/f42fb9421ed9a0808baf14bec797631729477e44))
* **act:** use Schema and EventMeta types in truncate implementations ([6c958a6](https://github.com/rotorsoft/act-root/commit/6c958a66b1dd15aa84750e20df976ff0bdbc8407))


### Features

* **act:** add close-the-books stream archival and truncation ([30d6587](https://github.com/rotorsoft/act-root/commit/30d6587c903022da5d0f10fa3b7b90521c2d60ce)), closes [#562](https://github.com/rotorsoft/act-root/issues/562)
* **act:** atomic guard-first close with truncate+seed transaction ([034e20a](https://github.com/rotorsoft/act-root/commit/034e20a5b2ee037cdd90af3531bf03c7115ebbd5))


### Performance Improvements

* **act-pg:** single DELETE RETURNING instead of SELECT count + DELETE ([fb00704](https://github.com/rotorsoft/act-root/commit/fb007047aa980e4c2d44be0d9cb1adf527b31370))

# [@rotorsoft/act-pg-v0.15.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.14.4...@rotorsoft/act-pg-v0.15.0) (2026-04-11)


### Features

* **act, act-pg:** add Store.reset() for projection rebuild ([66fa95a](https://github.com/rotorsoft/act-root/commit/66fa95ac63e03da4da472f14cc3776c1f09b1826)), closes [#564](https://github.com/rotorsoft/act-root/issues/564)

# [@rotorsoft/act-pg-v0.14.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.14.3...@rotorsoft/act-pg-v0.14.4) (2026-04-09)


### Bug Fixes

* **act:** harden framework with correctness and safety fixes ([7b6406a](https://github.com/rotorsoft/act-root/commit/7b6406aa5e7179e4d0a7bf3e91829670dd51226b))

# [@rotorsoft/act-pg-v0.14.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.14.2...@rotorsoft/act-pg-v0.14.3) (2026-04-08)


### Performance Improvements

* **act:** add PostgreSQL batch projection benchmark — 20x speedup ([44a4d06](https://github.com/rotorsoft/act-root/commit/44a4d0694a14914b04591002351661c3a2df82d0))
* **act:** pg batch benchmark at 1K/5K/10K — consistent ~19x speedup ([4b25585](https://github.com/rotorsoft/act-root/commit/4b25585b63c472b5fd43882c4cf5d3a63fe16daf))

# [@rotorsoft/act-pg-v0.14.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.14.1...@rotorsoft/act-pg-v0.14.2) (2026-03-29)


### Bug Fixes

* **security:** sanitize SQL identifiers, escape RegExp, fix code injection vectors ([afbe25e](https://github.com/rotorsoft/act-root/commit/afbe25e5e61c75d0d245070bb6c9b79affb9fe74))

# [@rotorsoft/act-pg-v0.14.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.14.0...@rotorsoft/act-pg-v0.14.1) (2026-03-27)


### Bug Fixes

* **act, act-pg:** add stream_exact query option for exact stream matching ([1ed4e5b](https://github.com/rotorsoft/act-root/commit/1ed4e5bf98ac454d60ea5aa9563e5338c75e2b2d))

# [@rotorsoft/act-pg-v0.14.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.13.1...@rotorsoft/act-pg-v0.14.0) (2026-03-25)


### Features

* **act:** add Logger interface JSDoc cross-references ([e9772d5](https://github.com/rotorsoft/act-root/commit/e9772d54fc5e70eed9b010d97efdfe96a68d1bfb))

# [@rotorsoft/act-pg-v0.13.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.13.0...@rotorsoft/act-pg-v0.13.1) (2026-03-16)


### Bug Fixes

* clear _needs_drain on empty claim, 100% line/function coverage, realistic PG bench ([08e350a](https://github.com/rotorsoft/act-root/commit/08e350a932d7a7deb7fe5101c346831c0386858a))

# [@rotorsoft/act-pg-v0.13.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.12.0...@rotorsoft/act-pg-v0.13.0) (2026-03-15)


### Features

* **act-pg:** pass through full pg.PoolConfig for connection tuning ([d8c8da9](https://github.com/rotorsoft/act-root/commit/d8c8da9001ce33ec85b4711e9a22c4204d293a56))

# [@rotorsoft/act-pg-v0.12.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.11.0...@rotorsoft/act-pg-v0.12.0) (2026-03-15)


### Features

* **act:** watermark-aware claim filtering ([23fcb78](https://github.com/rotorsoft/act-root/commit/23fcb7838dfd9c115d35faeb59cbf5989200028e))

# [@rotorsoft/act-pg-v0.11.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.10.0...@rotorsoft/act-pg-v0.11.0) (2026-03-15)


### Features

* **act:** correlation checkpoint with static resolver optimization ([2291906](https://github.com/rotorsoft/act-root/commit/2291906202aa5fdc332b7e9c96fc63fea85c8b8e))

# [@rotorsoft/act-pg-v0.10.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.9.0...@rotorsoft/act-pg-v0.10.0) (2026-03-15)


### Features

* **act:** replace poll/lease with claim/subscribe ([18a1444](https://github.com/rotorsoft/act-root/commit/18a1444f287046d1b1612e7f35f02f11e0a4e729))


### Performance Improvements

* **act:** add multi-worker contention benchmark ([9787cb6](https://github.com/rotorsoft/act-root/commit/9787cb6caec65787fd80f8f4aa31674ddd121a1f))

# [@rotorsoft/act-pg-v0.9.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.8.4...@rotorsoft/act-pg-v0.9.0) (2026-03-14)


### Features

* **act:** add PostgresStore cache benchmark and fix coverage ([8f8a901](https://github.com/rotorsoft/act-root/commit/8f8a901f326b637d94de075c129dbb3bc6e0d04d))
* **act:** add snap variants to cache benchmarks ([83ae55b](https://github.com/rotorsoft/act-root/commit/83ae55ba421669453280764729c1fae87372e81b))
* **act:** always-on cache with snap timing fix ([f797233](https://github.com/rotorsoft/act-root/commit/f7972335ee507bffe75b184e599b5b6298aaeee4))

# [@rotorsoft/act-pg-v0.8.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.8.3...@rotorsoft/act-pg-v0.8.4) (2026-03-14)


### Bug Fixes

* **act:** use workspace:^ and order CD matrix by dependency chain ([4a5287e](https://github.com/rotorsoft/act-root/commit/4a5287eb53a038cf8e81fcc8493427f7125fd94e))

# [@rotorsoft/act-pg-v0.8.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.8.2...@rotorsoft/act-pg-v0.8.3) (2026-03-13)


### Bug Fixes

* **act-pg:** use sequential inserts in commit to avoid pg deprecation warning ([92162a2](https://github.com/rotorsoft/act-root/commit/92162a29c6ea5e01a3484569de0261def8f6d99a))

# [@rotorsoft/act-pg-v0.8.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.8.1...@rotorsoft/act-pg-v0.8.2) (2026-03-05)


### Bug Fixes

* **deps:** update dependency pg to ^8.20.0 ([fa3dfd2](https://github.com/rotorsoft/act-root/commit/fa3dfd235ea04a3635b9bbbeeaea0eda291d8213))

# [@rotorsoft/act-pg-v0.8.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.8.0...@rotorsoft/act-pg-v0.8.1) (2026-03-02)


### Bug Fixes

* **deps:** update dependency pg to ^8.19.0 ([1610622](https://github.com/rotorsoft/act-root/commit/16106223189d4612a614455eeec7b3a025fc62b9))

# [@rotorsoft/act-pg-v0.8.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.7.0...@rotorsoft/act-pg-v0.8.0) (2026-02-20)


### Features

* **act:** streamline state builder with passthrough defaults ([fe1362f](https://github.com/rotorsoft/act-root/commit/fe1362fd912c14257fb4cfa1e765d0c85c5eb410))

# [@rotorsoft/act-pg-v0.7.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.6.0...@rotorsoft/act-pg-v0.7.0) (2026-02-18)


### Features

* rename builder methods to improve typings ([a22dd89](https://github.com/rotorsoft/act-root/commit/a22dd8969b52525fa340a9d4d35b4a679fdb2242))

# [@rotorsoft/act-pg-v0.6.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.5.22...@rotorsoft/act-pg-v0.6.0) (2026-02-13)


### Features

* **act:** replace state("Name", schema) with state({ Name: schema }) record shorthand ([db9a3f2](https://github.com/rotorsoft/act-root/commit/db9a3f24b661c784496d8a51c0e5176b453a6423)), closes [#390](https://github.com/rotorsoft/act-root/issues/390)
