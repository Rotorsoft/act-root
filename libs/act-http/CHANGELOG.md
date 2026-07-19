# [@rotorsoft/act-http-v1.8.8](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.8.7...@rotorsoft/act-http-v1.8.8) (2026-07-19)


### Bug Fixes

* **act-http:** map a tRPC actor-extractor deny to UNAUTHORIZED, not 500 ([#1286](https://github.com/rotorsoft/act-root/issues/1286)) ([f16c971](https://github.com/rotorsoft/act-root/commit/f16c97182774edc2c64963358f912f4ada411b58))

# [@rotorsoft/act-http-v1.8.7](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.8.6...@rotorsoft/act-http-v1.8.7) (2026-07-18)


### Bug Fixes

* **act-http:** map tRPC error codes by identity so wire status matches Hono/OpenAPI ([#1280](https://github.com/rotorsoft/act-root/issues/1280)) ([8cbd4c4](https://github.com/rotorsoft/act-root/commit/8cbd4c4c91b24f625ce7cdcf42c5126653cadc18))

# [@rotorsoft/act-http-v1.8.6](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.8.5...@rotorsoft/act-http-v1.8.6) (2026-07-12)


### Bug Fixes

* **act-http:** bound sse pending buffer and pair slot release with acquire ([29ad7bd](https://github.com/rotorsoft/act-root/commit/29ad7bddd907ddc007638b6d1b59fee500aed600)), closes [#1196](https://github.com/rotorsoft/act-root/issues/1196)

# [@rotorsoft/act-http-v1.8.5](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.8.4...@rotorsoft/act-http-v1.8.5) (2026-07-11)


### Bug Fixes

* **act-http:** funnel hono validation failures through the ApiError envelope at 422 ([#1226](https://github.com/rotorsoft/act-root/issues/1226)) ([65096c3](https://github.com/rotorsoft/act-root/commit/65096c33137daf98ff274766ee46f430a5c6891a))
* **act-http:** mark sensitive() action-input fields in the openapi request schema ([#1228](https://github.com/rotorsoft/act-root/issues/1228)) ([003eea2](https://github.com/rotorsoft/act-root/commit/003eea2bfd97c35641ee585a0a26cab40fa1c564))
* **act-http:** surface a distinct empty-body error when raw body is not captured ([#1227](https://github.com/rotorsoft/act-root/issues/1227)) ([15db895](https://github.com/rotorsoft/act-root/commit/15db895113e6124966d4812b062fd5b975edf6eb))

# [@rotorsoft/act-http-v1.8.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.8.3...@rotorsoft/act-http-v1.8.4) (2026-07-11)


### Bug Fixes

* **act-http:** commit receiver idempotency key on success, not on claim ([9badb1a](https://github.com/rotorsoft/act-root/commit/9badb1afdce72fb4813178fb2ea7e110057a2460)), closes [#1193](https://github.com/rotorsoft/act-root/issues/1193)

# [@rotorsoft/act-http-v1.8.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.8.2...@rotorsoft/act-http-v1.8.3) (2026-07-11)


### Bug Fixes

* **act-http:** require integer sse maxConnections and heartbeatMs ([7f3a502](https://github.com/rotorsoft/act-root/commit/7f3a502b4cae638b998df9d3389909eb71c5f60a)), closes [#1235](https://github.com/rotorsoft/act-root/issues/1235)

# [@rotorsoft/act-http-v1.8.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.8.1...@rotorsoft/act-http-v1.8.2) (2026-07-06)


### Bug Fixes

* **deps:** update non-major dependencies ([8df28a7](https://github.com/rotorsoft/act-root/commit/8df28a79caea4df01850dc1a5e9d14e806e5cdeb))

# [@rotorsoft/act-http-v1.8.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.8.0...@rotorsoft/act-http-v1.8.1) (2026-07-06)


### Bug Fixes

* **deps:** update non-major dependencies ([#1156](https://github.com/rotorsoft/act-root/issues/1156)) ([b460cdc](https://github.com/rotorsoft/act-root/commit/b460cdcdb64dc6c5c1f538a0fe955a19aabce145))

# [@rotorsoft/act-http-v1.8.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.7.5...@rotorsoft/act-http-v1.8.0) (2026-07-05)


### Features

* **act-http:** camelcase aliases for sse public members, deprecate snake_case ([#1139](https://github.com/rotorsoft/act-root/issues/1139)) ([71bbcd9](https://github.com/rotorsoft/act-root/commit/71bbcd955228aff8310894707f7ce5983ef6ab85))

# [@rotorsoft/act-http-v1.7.5](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.7.4...@rotorsoft/act-http-v1.7.5) (2026-06-29)


### Bug Fixes

* **deps:** update non-major dependencies ([#1098](https://github.com/rotorsoft/act-root/issues/1098)) ([1d9d491](https://github.com/rotorsoft/act-root/commit/1d9d49111f86d74d79078355bb3f756ccc730e73))

# [@rotorsoft/act-http-v1.7.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.7.3...@rotorsoft/act-http-v1.7.4) (2026-06-21)


### Bug Fixes

* **deps:** update dependency hono to ^4.12.26 ([e81f15c](https://github.com/rotorsoft/act-root/commit/e81f15ce074c02839c04adb14adb67de8ad6144d))

# [@rotorsoft/act-http-v1.7.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.7.2...@rotorsoft/act-http-v1.7.3) (2026-06-20)


### Bug Fixes

* **deps:** update trpc monorepo to v11.18.0 ([34b8aa5](https://github.com/rotorsoft/act-root/commit/34b8aa573555b2eeb2f742b27e48c4d1f9739edb))

# [@rotorsoft/act-http-v1.7.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.7.1...@rotorsoft/act-http-v1.7.2) (2026-06-18)


### Bug Fixes

* **deps:** update dependency @hono/node-server to ^2.0.5 ([498af83](https://github.com/rotorsoft/act-root/commit/498af83aaaa092a36ca73b1f7a9325f3d61ef986))

# [@rotorsoft/act-http-v1.7.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.7.0...@rotorsoft/act-http-v1.7.1) (2026-06-11)

# [@rotorsoft/act-http-v1.7.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.6.0...@rotorsoft/act-http-v1.7.0) (2026-06-11)


### Features

* **act-http:** [#846](https://github.com/rotorsoft/act-root/issues/846) — generated SSE subscriptions on trpc + hono ([142955d](https://github.com/rotorsoft/act-root/commit/142955ddb93b750ff705b9b1a0a20bfe23b6d126)), closes [#835](https://github.com/rotorsoft/act-root/issues/835)

# [@rotorsoft/act-http-v1.6.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.5.0...@rotorsoft/act-http-v1.6.0) (2026-06-11)


### Features

* **server:** [#847](https://github.com/rotorsoft/act-root/issues/847) — multi-transport calculator demo (trpc + hono rest + openapi) ([8e959a7](https://github.com/rotorsoft/act-root/commit/8e959a75732bc44e2c58c40d3f17e83ffb8d2f9c))

# [@rotorsoft/act-http-v1.5.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.4.0...@rotorsoft/act-http-v1.5.0) (2026-06-11)


### Bug Fixes

* **act-http:** [#845](https://github.com/rotorsoft/act-root/issues/845) — tighten openapi server-url regex to avoid CodeQL ReDoS alert ([c450492](https://github.com/rotorsoft/act-root/commit/c4504928545ceb57d0a7af304f9c4c56b81483bb))


### Features

* **act-http:** [#845](https://github.com/rotorsoft/act-root/issues/845) — @rotorsoft/act-http/openapi subpath emits OpenAPI 3.1 documents ([6398c16](https://github.com/rotorsoft/act-root/commit/6398c1636ed893d30f8901caa89f1d8a2d4db61d))

# [@rotorsoft/act-http-v1.4.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.3.0...@rotorsoft/act-http-v1.4.0) (2026-06-11)


### Features

* **act-http:** [#844](https://github.com/rotorsoft/act-root/issues/844) — @rotorsoft/act-http/hono subpath generates a typed REST surface ([3a5274c](https://github.com/rotorsoft/act-root/commit/3a5274cb15255f747f5a988d1755a6892d142652))

# [@rotorsoft/act-http-v1.3.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.2.1...@rotorsoft/act-http-v1.3.0) (2026-06-11)


### Features

* **act-http:** [#843](https://github.com/rotorsoft/act-root/issues/843) — @rotorsoft/act-http/trpc subpath generates a typed tRPC router ([1d29e55](https://github.com/rotorsoft/act-root/commit/1d29e55582982c2e2c344ff473553cbc4690bba2)), closes [#844](https://github.com/rotorsoft/act-root/issues/844) [#845](https://github.com/rotorsoft/act-root/issues/845) [#847](https://github.com/rotorsoft/act-root/issues/847)
* **act-http:** [#843](https://github.com/rotorsoft/act-root/issues/843) — TrpcOptions.expectedVersion threads optimistic concurrency ([d05a3bc](https://github.com/rotorsoft/act-root/commit/d05a3bca8440ce25d73860c53573684eabd41e11)), closes [#844](https://github.com/rotorsoft/act-root/issues/844) [#845](https://github.com/rotorsoft/act-root/issues/845)

# [@rotorsoft/act-http-v1.2.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.2.0...@rotorsoft/act-http-v1.2.1) (2026-06-07)

# [@rotorsoft/act-http-v1.2.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.1.0...@rotorsoft/act-http-v1.2.0) (2026-06-04)


### Features

* **act-http:** shared utilities for the auto-generated API ([#842](https://github.com/rotorsoft/act-root/issues/842)) ([99350e7](https://github.com/rotorsoft/act-root/commit/99350e7102b165ae92e605f376ca736872f49e21)), closes [#843](https://github.com/rotorsoft/act-root/issues/843) [#844](https://github.com/rotorsoft/act-root/issues/844) [#845](https://github.com/rotorsoft/act-root/issues/845)

# [@rotorsoft/act-http-v1.1.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v1.0.0...@rotorsoft/act-http-v1.1.0) (2026-05-31)


### Features

* **act-http:** add /receiver subpath with extractIdempotencyKey ([d423565](https://github.com/rotorsoft/act-root/commit/d423565511c8721dc36ef9cb1a9c75b1600fcce4)), closes [#832](https://github.com/rotorsoft/act-root/issues/832) [#832](https://github.com/rotorsoft/act-root/issues/832) [#832](https://github.com/rotorsoft/act-root/issues/832) [#833](https://github.com/rotorsoft/act-root/issues/833) [#743](https://github.com/rotorsoft/act-root/issues/743)
* **act-http:** extract classifyHttpResponse helper from webhook ([1f56c60](https://github.com/rotorsoft/act-root/commit/1f56c60b125b178a18a00d194ffc7820c1ebc518)), closes [#742](https://github.com/rotorsoft/act-root/issues/742)
* **act-http:** paired HMAC-SHA256 webhook signing + verification ([298ef82](https://github.com/rotorsoft/act-root/commit/298ef824c714ae15209de745e77d0eefa957888e))
* **act-http:** receiver middleware — core + tRPC/Express/Fastify/Hono adapters ([87a4ee5](https://github.com/rotorsoft/act-root/commit/87a4ee56de38b048a48b3d0c0274933b8a2bfb6b)), closes [#744](https://github.com/rotorsoft/act-root/issues/744) [#743](https://github.com/rotorsoft/act-root/issues/743) [833/#834](https://github.com/rotorsoft/act-root/issues/834) [#743](https://github.com/rotorsoft/act-root/issues/743) [#744](https://github.com/rotorsoft/act-root/issues/744)
* **act-http:** treat empty Idempotency-Key as missing in extractIdempotencyKey ([f91b628](https://github.com/rotorsoft/act-root/commit/f91b62812d6edc22e380b62c08dea3738e91bff5))
* **act-http:** tryOk helper + generic Retryable/NonRetryable HTTP error classes ([017d93c](https://github.com/rotorsoft/act-root/commit/017d93c3812dc2a6aa828aa3709e5d2a84552110))
* **act-ops, act-http:** high-level WebhookReceiver port + Hono-based adapter ([49d4799](https://github.com/rotorsoft/act-root/commit/49d479990f5f377f8c9a47254746ea356f01bdba)), closes [hi#level](https://github.com/hi/issues/level) [hi#level](https://github.com/hi/issues/level) [Hi#level](https://github.com/Hi/issues/level) [hi#level](https://github.com/hi/issues/level) [hi#level](https://github.com/hi/issues/level) [#742](https://github.com/rotorsoft/act-root/issues/742) [#743](https://github.com/rotorsoft/act-root/issues/743) [#744](https://github.com/rotorsoft/act-root/issues/744) [hi#level](https://github.com/hi/issues/level)

# [@rotorsoft/act-http-v1.0.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v0.2.0...@rotorsoft/act-http-v1.0.0) (2026-05-21)


* chore(act-http)!: enter 1.0 stability commitment ([73dd7d4](https://github.com/rotorsoft/act-root/commit/73dd7d409c8356d92c56b2b14118fc0bc60d7256)), closes [#702](https://github.com/rotorsoft/act-root/issues/702)


### BREAKING CHANGES

* This is the 1.0 release of @rotorsoft/act-http. The
package's public exports — the `webhook` helper (`@rotorsoft/act-http
/webhook`) and the SSE surface (`@rotorsoft/act-http/sse`, which hosts
the API formerly published as @rotorsoft/act-sse) — are now covered by
SemVer per STABILITY.md. Breaking changes require a major bump.

# [@rotorsoft/act-http-v0.2.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v0.1.0...@rotorsoft/act-http-v0.2.0) (2026-05-16)


* feat(act)!: add non-retryable error class for handler-signaled block (ACT-604) ([09cdfe0](https://github.com/rotorsoft/act-root/commit/09cdfe0ca753690bea348993b043fa4f84b293a7))


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
* @rotorsoft/act-http WebhookError no longer carries a
'retryable' field. Callers checking err.retryable should switch to
'err instanceof NonRetryableWebhookError' (or 'instanceof
NonRetryableError' for the framework-general check). The package is at
0.1.0 with no external consumers.

Closes ACT-604.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

# [@rotorsoft/act-http-v0.1.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-http-v0.0.0...@rotorsoft/act-http-v0.1.0) (2026-05-16)


### Features

* **act-http:** umbrella package with webhook helper and SSE module (ACT-602) ([0aa1c48](https://github.com/rotorsoft/act-root/commit/0aa1c48d94f1dc3748a8341a2a486b53174eb85b))

# Changelog
