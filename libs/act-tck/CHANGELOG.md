# [@rotorsoft/act-tck-v1.15.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.14.0...@rotorsoft/act-tck-v1.15.0) (2026-06-22)


### Features

* **act:** add StoreError and orchestrator circuit breaker for store failures ([71852c6](https://github.com/rotorsoft/act-root/commit/71852c6be437a64af3df49adcc582e0d7c3d7147)), closes [#984](https://github.com/rotorsoft/act-root/issues/984)

# [@rotorsoft/act-tck-v1.14.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.13.3...@rotorsoft/act-tck-v1.14.0) (2026-06-20)


### Features

* **act-tck:** run store property + concurrency contracts on durable adapters ([f5c9412](https://github.com/rotorsoft/act-root/commit/f5c9412e487a4be6be5fae551b7cdab13b28062d)), closes [#982](https://github.com/rotorsoft/act-root/issues/982)

# [@rotorsoft/act-tck-v1.13.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.13.2...@rotorsoft/act-tck-v1.13.3) (2026-06-20)


### Bug Fixes

* **act-sse:** re-export @rotorsoft/act-http/sse instead of duplicating it ([26ab476](https://github.com/rotorsoft/act-root/commit/26ab4760c6cabcfa6092569bb7bedecae9d33dd7)), closes [#981](https://github.com/rotorsoft/act-root/issues/981)

# [@rotorsoft/act-tck-v1.13.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.13.1...@rotorsoft/act-tck-v1.13.2) (2026-06-20)


### Bug Fixes

* **act-tck:** pin claim() lease semantics and align pg/sqlite adapters ([86f940e](https://github.com/rotorsoft/act-root/commit/86f940e14112afa9def0876878cfc3d46562ca7b)), closes [#980](https://github.com/rotorsoft/act-root/issues/980)

# [@rotorsoft/act-tck-v1.13.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.13.0...@rotorsoft/act-tck-v1.13.1) (2026-06-20)


### Bug Fixes

* **act:** throw on duplicate reaction/projection handler names ([974b6fd](https://github.com/rotorsoft/act-root/commit/974b6fda59f1f97374d4493cea87aa93e0c3a28e)), closes [#979](https://github.com/rotorsoft/act-root/issues/979)

# [@rotorsoft/act-tck-v1.13.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.12.0...@rotorsoft/act-tck-v1.13.0) (2026-06-13)


### Features

* **act:** [#838](https://github.com/rotorsoft/act-root/issues/838) — \`when({...})\` close-policy factory ([1404912](https://github.com/rotorsoft/act-root/commit/14049128a45291a337496135191e2251114d2b77)), closes [#839](https://github.com/rotorsoft/act-root/issues/839) [#840](https://github.com/rotorsoft/act-root/issues/840)

# [@rotorsoft/act-tck-v1.12.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.11.0...@rotorsoft/act-tck-v1.12.0) (2026-06-11)


### Features

* **act:** [#837](https://github.com/rotorsoft/act-root/issues/837) — .autocloses + .archives state-builder declarators (slice 1 / 4) ([b4c7bab](https://github.com/rotorsoft/act-root/commit/b4c7bab57f1d257c16117311554850b473dac7b3)), closes [#802](https://github.com/rotorsoft/act-root/issues/802) [#838](https://github.com/rotorsoft/act-root/issues/838) [#839](https://github.com/rotorsoft/act-root/issues/839) [#840](https://github.com/rotorsoft/act-root/issues/840)
* **act:** [#837](https://github.com/rotorsoft/act-root/issues/837) — AutocloseController wired into the orchestrator (slice 3 / 4) ([bebc2b9](https://github.com/rotorsoft/act-root/commit/bebc2b9a3bddf389e487d00d3140bec3039745a6)), closes [#802](https://github.com/rotorsoft/act-root/issues/802)

# [@rotorsoft/act-tck-v1.11.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.10.0...@rotorsoft/act-tck-v1.11.0) (2026-06-11)


### Features

* **act-http:** [#846](https://github.com/rotorsoft/act-root/issues/846) — generated SSE subscriptions on trpc + hono ([142955d](https://github.com/rotorsoft/act-root/commit/142955ddb93b750ff705b9b1a0a20bfe23b6d126)), closes [#835](https://github.com/rotorsoft/act-root/issues/835)

# [@rotorsoft/act-tck-v1.10.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.9.0...@rotorsoft/act-tck-v1.10.0) (2026-06-11)


### Features

* **server:** [#847](https://github.com/rotorsoft/act-root/issues/847) — multi-transport calculator demo (trpc + hono rest + openapi) ([8e959a7](https://github.com/rotorsoft/act-root/commit/8e959a75732bc44e2c58c40d3f17e83ffb8d2f9c))

# [@rotorsoft/act-tck-v1.9.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.8.0...@rotorsoft/act-tck-v1.9.0) (2026-06-11)


### Features

* **act-http:** [#845](https://github.com/rotorsoft/act-root/issues/845) — @rotorsoft/act-http/openapi subpath emits OpenAPI 3.1 documents ([6398c16](https://github.com/rotorsoft/act-root/commit/6398c1636ed893d30f8901caa89f1d8a2d4db61d))

# [@rotorsoft/act-tck-v1.8.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.7.0...@rotorsoft/act-tck-v1.8.0) (2026-06-11)


### Features

* **act-http:** [#844](https://github.com/rotorsoft/act-root/issues/844) — @rotorsoft/act-http/hono subpath generates a typed REST surface ([3a5274c](https://github.com/rotorsoft/act-root/commit/3a5274cb15255f747f5a988d1755a6892d142652))

# [@rotorsoft/act-tck-v1.7.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.6.0...@rotorsoft/act-tck-v1.7.0) (2026-06-11)


### Features

* **act-http:** [#843](https://github.com/rotorsoft/act-root/issues/843) — @rotorsoft/act-http/trpc subpath generates a typed tRPC router ([1d29e55](https://github.com/rotorsoft/act-root/commit/1d29e55582982c2e2c344ff473553cbc4690bba2)), closes [#844](https://github.com/rotorsoft/act-root/issues/844) [#845](https://github.com/rotorsoft/act-root/issues/845) [#847](https://github.com/rotorsoft/act-root/issues/847)
* **act-http:** [#843](https://github.com/rotorsoft/act-root/issues/843) — TrpcOptions.expectedVersion threads optimistic concurrency ([d05a3bc](https://github.com/rotorsoft/act-root/commit/d05a3bca8440ce25d73860c53573684eabd41e11)), closes [#844](https://github.com/rotorsoft/act-root/issues/844) [#845](https://github.com/rotorsoft/act-root/issues/845)

# [@rotorsoft/act-tck-v1.6.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.5.4...@rotorsoft/act-tck-v1.6.0) (2026-06-10)


### Features

* **act-pg,act-sqlite:** [#921](https://github.com/rotorsoft/act-root/issues/921) — adapter-layer PII column encryption via @rotorsoft/act-crypto ([e0b1109](https://github.com/rotorsoft/act-root/commit/e0b11099a4fe2f333f3a2b045df1cf6728854e71))

# [@rotorsoft/act-tck-v1.5.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.5.3...@rotorsoft/act-tck-v1.5.4) (2026-06-09)

# [@rotorsoft/act-tck-v1.5.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.5.2...@rotorsoft/act-tck-v1.5.3) (2026-06-07)

# [@rotorsoft/act-tck-v1.5.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.5.1...@rotorsoft/act-tck-v1.5.2) (2026-06-07)

# [@rotorsoft/act-tck-v1.5.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.5.0...@rotorsoft/act-tck-v1.5.1) (2026-06-07)

# [@rotorsoft/act-tck-v1.5.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.4.0...@rotorsoft/act-tck-v1.5.0) (2026-06-04)


### Features

* **act:** pii_isolation Store contract — capability + forget_pii + TCK ([#868](https://github.com/rotorsoft/act-root/issues/868)) ([eced65c](https://github.com/rotorsoft/act-root/commit/eced65c4777547edd9876253fca1e8f92c75a950)), closes [#566](https://github.com/rotorsoft/act-root/issues/566) [#855](https://github.com/rotorsoft/act-root/issues/855) [870/#871](https://github.com/rotorsoft/act-root/issues/871)

# [@rotorsoft/act-tck-v1.4.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.3.0...@rotorsoft/act-tck-v1.4.0) (2026-05-30)


### Features

* **inspector:** restore wizard, csv viewer, dry-run preview modal ([3809025](https://github.com/rotorsoft/act-root/commit/3809025f75e79846c23e2f8da49a1a68afdeb8d1)), closes [#785](https://github.com/rotorsoft/act-root/issues/785)

# [@rotorsoft/act-tck-v1.3.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.2.0...@rotorsoft/act-tck-v1.3.0) (2026-05-28)


### Features

* **act:** eventsource/eventsink interfaces + csvfile + backpressured iterate util ([738f0eb](https://github.com/rotorsoft/act-root/commit/738f0eb49944b30de0363ecf406da91bbfa069f8)), closes [#788](https://github.com/rotorsoft/act-root/issues/788) [#814](https://github.com/rotorsoft/act-root/issues/814) [#784](https://github.com/rotorsoft/act-root/issues/784) [#814](https://github.com/rotorsoft/act-root/issues/814)

# [@rotorsoft/act-tck-v1.2.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.1.0...@rotorsoft/act-tck-v1.2.0) (2026-05-26)


### Features

* **act:** restoreoptions compaction + dry-run + progress (ACT-1125) ([51164c6](https://github.com/rotorsoft/act-root/commit/51164c6c8c33e8f4dac192d0d5c0a1120340e0b1)), closes [#783](https://github.com/rotorsoft/act-root/issues/783) [#783](https://github.com/rotorsoft/act-root/issues/783) [#783](https://github.com/rotorsoft/act-root/issues/783) [#783](https://github.com/rotorsoft/act-root/issues/783) [#784](https://github.com/rotorsoft/act-root/issues/784)

# [@rotorsoft/act-tck-v1.1.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.0.0...@rotorsoft/act-tck-v1.1.0) (2026-05-25)


### Features

* **act:** store.restore port method + tck + adapter impls (ACT-1124) ([104db4b](https://github.com/rotorsoft/act-root/commit/104db4bd18389f2e14e6be96337ed9aa62b6318a)), closes [#786](https://github.com/rotorsoft/act-root/issues/786) [#784](https://github.com/rotorsoft/act-root/issues/784) [#785](https://github.com/rotorsoft/act-root/issues/785) [#784](https://github.com/rotorsoft/act-root/issues/784) [#784](https://github.com/rotorsoft/act-root/issues/784) [#789](https://github.com/rotorsoft/act-root/issues/789) [#802](https://github.com/rotorsoft/act-root/issues/802) [#783](https://github.com/rotorsoft/act-root/issues/783)

# [@rotorsoft/act-tck-v1.0.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v0.4.0...@rotorsoft/act-tck-v1.0.0) (2026-05-21)


* chore(act-tck)!: enter 1.0 stability commitment ([ff7a0dc](https://github.com/rotorsoft/act-root/commit/ff7a0dc17b10d2a5be660fd66ee3c19930c43a6c)), closes [#774](https://github.com/rotorsoft/act-root/issues/774) [#702](https://github.com/rotorsoft/act-root/issues/702)


### BREAKING CHANGES

* This is the 1.0 release of @rotorsoft/act-tck. The
kit's published surface — `runStoreTck`, `runCacheTck`,
`runLoggerTck`, the `Capabilities` types, and the fixture helpers —
is now covered by SemVer per STABILITY.md, alongside the
Store/Cache/Logger contracts the TCK validates. Breaking changes
require a major bump and a written migration note.

# [@rotorsoft/act-tck-v0.4.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v0.3.0...@rotorsoft/act-tck-v0.4.0) (2026-05-19)


### Features

* **act-sqlite:** wire lanes through SqliteStore and consolidate the lane contract into the TCK ([70c062b](https://github.com/rotorsoft/act-root/commit/70c062b256b273982ca9e6d155a8606020fd35e4))

# [@rotorsoft/act-tck-v0.4.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v0.3.0...@rotorsoft/act-tck-v0.4.0) (2026-05-19)


### Features

* **act-sqlite:** wire lanes through SqliteStore and consolidate the lane contract into the TCK ([70c062b](https://github.com/rotorsoft/act-root/commit/70c062b256b273982ca9e6d155a8606020fd35e4))

# [@rotorsoft/act-tck-v0.3.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v0.2.0...@rotorsoft/act-tck-v0.3.0) (2026-05-17)


### Features

* **act:** add Store.query_stats — batched per-stream aggregates ([#752](https://github.com/rotorsoft/act-root/issues/752)) ([fb1cbbc](https://github.com/rotorsoft/act-root/commit/fb1cbbcb99d02fd20bb3a6fa54ae48822f09c439)), closes [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#708](https://github.com/rotorsoft/act-root/issues/708) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#708](https://github.com/rotorsoft/act-root/issues/708) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639)

# [@rotorsoft/act-tck-v0.2.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v0.1.0...@rotorsoft/act-tck-v0.2.0) (2026-05-16)


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

# [@rotorsoft/act-tck-v0.1.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v0.0.0...@rotorsoft/act-tck-v0.1.0) (2026-05-14)


### Features

* **act-tck:** extract Store/Cache/Logger TCK package (ACT-302) ([ff9bfd4](https://github.com/rotorsoft/act-root/commit/ff9bfd44b3cf36890186c6db7965c531458953a2))
* **act-tck:** re-export Store/Cache/Logger port types ([f23f535](https://github.com/rotorsoft/act-root/commit/f23f53532ebcf03db48d8a1c7e13887c13491833)), closes [#716](https://github.com/rotorsoft/act-root/issues/716)
