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
