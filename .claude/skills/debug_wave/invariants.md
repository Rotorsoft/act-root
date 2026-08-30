# Debug Wave — standing invariants

**Read this file before every wave. It is short on purpose.**

These are the facts a hunter must not violate and the mechanics that have
cost previous waves real time. A red test that only "works" by contradicting
something here is testing a fantasy, not a bug.

The history — every confirmed bug, every false positive, and the per-wave
logs — lives in [bug-log.md](bug-log.md). Don't read it end to end. Consult
the entries for **your lens** before you start, and the confirmed-bug list
before you file, so you don't re-report something already fixed or already
ruled out.

Two rules that apply to every finding, whatever the lens:

- **Before proposing a fix, read what the commit that introduced the code
  already tried.** A commit's reasoning and its rejected alternatives are
  different things, and re-proposing a rejected design wastes the finding.
  This is how wave 21's first fix direction for #1594 went wrong.
- **A finding reachable only through a type cast or private-state mutation
  must say so plainly.** The type layer rejects many of these at compile
  time, and a repro that quietly bypasses it reads as more severe than the
  defect is.

## Standing invariants a hunter must not violate

These are load-bearing facts about the framework. A red test that only "works" by contradicting one of these is testing a fantasy, not a bug.

- **Global event ids are strictly monotonic.** A later commit always gets a higher `id` than any earlier one. Any argument that depends on a future commit landing at a *lower* id — "the scan skips it", "the watermark advances past it" — is invalid. This single fact killed the #1254 false positive: advancing an empty-fetch stream to a window-max can never skip a future event, because a future event will have a higher id than the window-max.
- **`fetch_window_at` fallback is load-bearing.** In `drain-cycle.ts`, `const at = entry.fetch.events.at(-1)?.id || fetch_window_at` — the `fetch_window_at` fallback is what lets an empty-fetch stream advance so settle converges. Changing it to `?? lease.at` (or similar) hangs the notify/scope suites in an infinite settle loop. Not a bug.
- **The framework has no built-in dedup, by design.** See `docs/docs/architecture/concurrency-model.md` ("why no framework-level dedup"). Do not report "the same event could be delivered twice under X" as a bug — at-least-once with consumer-side idempotency is the deliberate contract.
- **Reaction backoff is a persisted per-stream schedule** (since #1262). A retry-with-backoff persists `deferred_at = now + delay` via a due-marked `ack` and releases the lease, so every worker honors the window (the store excludes the stream from `claim`), `retry` advances once per real attempt, and a stream blocks after exactly `maxRetries` attempts regardless of worker count. The due-ack carries the climbing `retry` (budget survives the window); an explicit defer passes `retry: -1` (not a failure). Do **not** re-report the old "per-worker, N× amplification, floor = max(configured, leaseMillis)" behavior — that was the #1262 bug, now fixed. See `docs/docs/concepts/error-handling.md` § Backoff.
- **`created` is not monotonic with `id`.** Restore preserves source timestamps verbatim, so timestamp order can diverge from insertion order. Time bounds (`created_before`/`created_after`) are pure filters, never id-ordered early-breaks. (This was #1258; the principle stands for any new code that touches `created`.)
- **Fairness is store-internal by design.** The `Store.claim` signature did not change for the #1223/#1252 fairness reserve — each adapter infers the `fair = lagging>=2 ? max(1, floor(lagging/4)) : 0` split inline. Do not propose exposing fairness through the claim interface; that reshape was explicitly rejected.
- **Close/autoclose surfaces are days-only.** Never ms/seconds/minutes on a close-facing API. The one-day floor is deliberate — close is low-cadence housekeeping. Not a bug.
- **Windowed close prunes, it does not retire.** `close`/`.autocloses` delete only the prefix below the closest safe `__snapshot__`; no tombstone, subscriptions and cache untouched, stream stays live. No qualifying snapshot ⇒ `skipped`, not an error.
- **Some InMemory shortcuts are legitimate.** InMemory is single-process and dev/test-only. `notify` is intentionally unimplemented. Not every InMemory-vs-SQL difference is a divergence — check whether the doc-comment declares the behavior best-effort or capability-gated (e.g. `query_streams.source_matches` MAY return a superset) before calling it a bug.
- **A sensitive-bearing state cannot snapshot via `.snap(...)` — enforced at build time, but `restart: true` bypasses it.** `act-builder.ts:665-674` throws at `act().build()` if a state whose events carry `sensitive()` fields also declares `.snap(...)` ("Snapshots write derived state into `__snapshot__.data`, which `forget_pii` cannot reach"). **CORRECTION (wave 14, #1397):** the wave-6 claim that a PII state therefore "never produces a `__snapshot__` event — structurally impossible" is FALSE. `close({restart:true})` seeds a `__snapshot__` with an *actorless* (default-denied) fold, writing `[REDACTED]` and then deleting the plaintext. The build guard covers the declaration path only; the close path never consults `restart_supported`. Snapshot-based PII *resurrection* remains foreclosed (the seed holds the sentinel, not plaintext) — but "a PII state never snapshots" must not be assumed.
- **Lifecycle listeners are contained, not fatal (since #1373).** A throwing `acked`/`blocked`/`closed` listener is logged and swallowed; the drain cycle still finalizes, the remaining sinks still fire, `drain()` returns its real result, and no `error` (circuit-breaker) event is emitted. Do not re-report the *contained* behavior as a swallowed bug — it is the documented contract (`observability.md`, plus a `behavior-contracts.md` row). **CORRECTION (wave 14, #1388):** the original wording claimed "a genuine store failure inside `on_close`'s close machinery still reaches the breaker." That is FALSE in master — `on_close` is not an emit (it runs `run_close_cycle`: load, tombstone, archive, truncate, and only then emits `closed`), and #1376 wrapped the whole thing in `contain_async`, so real `StoreError`s are swallowed. The line described the intent of the fix, not the shipped code, and nothing executable pinned it.
- **Framework-internal `query_streams` walks are paged, and the two markers are treated asymmetrically.** Callers wanting every stream use the internal `walk_streams` helper (since #1371) rather than the store default of `limit: 100`. Separately (since #1374), the audit's shared stat scan excludes `SNAP_EVENT` so heads and counts are DOMAIN figures, but deliberately does **not** exclude `TOMBSTONE_EVENT` — a tombstoned stream really is closed and the `startsWith("__")` head check is what recognizes it. Do not "fix" that asymmetry; filtering both markers trades one bug for its mirror image.
- **Date typing is schema-driven and Zod does the parsing — do NOT propose a hand-rolled walk (since #1570).** Wave 19 found #1556 (`dateReviver` revived by *shape*, so an ISO-looking `z.string()` came back a `Date`); #1570 fixed it by resolving each event's `z.date()` paths from the declared schema at build. Its **first** implementation was a targeted traversal that converted dates in place, and the same PR replaced it with a Zod transform because the walk punted on arrays, records and unions and would drift as Zod grew constructs. A later wave (21) found real regressions in the parse-based version (#1594) and its first proposed fix was "walk the shape and convert" — i.e. the rejected design, re-proposed because the hunter read the commit's `looseObject` rationale but not its rejected-alternatives history. **Before proposing a fix, read what the commit that introduced the code already tried.** The live problem is that the read schema doesn't describe what's stored (sensitive keys are in `pii`, not `data`) and that a mismatch throws instead of being tolerated — not that Zod is doing the parsing.
- **There is exactly ONE date reviver (since #1380).** `dateReviver` is exported from `@rotorsoft/act` (`utils.ts`, RFC 1380) and imported by every adapter; the previous per-adapter copies in `act-pg/src/utils.ts` and `act-sqlite/src/sqlite-store.ts` are gone. Adapters must apply it to **every** JSON column they read, including decrypted `pii` (`decrypt` takes an optional reviver). A value's runtime type must never depend on which column it sits in or whether `pii_encryption` is on. A new adapter that hand-rolls its own ISO-8601 regex is a defect, not a style choice.
- **SQLite stores `deferred_at` as a fixed-width ISO-8601 UTC string; it is NOT a divergence.** `defer`/due-ack store `new Date(ms).toISOString()` and `claim` compares against `new Date().toISOString()` — same fixed-width format, so lexicographic == chronological for all realistic dates (only misorders at year ≥ 10000, unreachable). `query_streams` reverts to ms via `getTime()`, matching PG's `.getTime()` and InMemory's raw ms; whole-ms integers round-trip exactly. Verified across a 10-scenario differential (InMemory ≡ PG ≡ SQLite). Do not re-file SQLite `deferred_at` reporting/claim-eligibility as a bug. *(Latent test-coverage gap, not a live bug: `store-differential-tck.ts:816-841` omits `deferred_at` and the `leased_until` value from its comparison row — a future adapter refactor touching `deferred_at` reporting wouldn't be caught; adding it to that row would close the gap.)*


## Mechanics that bit us

- Postgres test DB is on **5431** (not 5432): `postgres://postgres:postgres@localhost:5431`. `docker ps` shows container `act-pg`.
- Vitest ignores specs outside the project root — a probe in `/tmp` or the scratchpad reports `No test files found`. Write probes into the package's `test/` dir, run, delete.
- Any *real* fix that changes source text of a public export (adapters, `runStoreTck`) shifts the stability snapshots. Regenerate them **after** biome formats the source (`npx biome check --write` then `vitest -u` on the stability spec), and expect the rfc-gate to want an `rfc-gate: exempt — ...` line when the snapshot grows only from embedded test/comment text.

### The retry budget is spent on the error path only (#1418)

`finalize` returns early when a handler didn't throw, so `blockOnError` only
ever terminates handlers that fail *loudly*. A handler that fails by
overrunning its lease never throws: it completes, submits an ack the store
drops (`WHERE leased_by = by`), and the next claim bumps `retry` again.
Reproduced at store level against Postgres — five rounds of
claim/steal/late-ack left `retry` at 9, `at` at -1, `blocked` false, forever.

Two things follow for future waves:

- **`retry` climbing without the watermark moving is not a store bug.** Every
  adapter bumps `retry` in `claim` and resets it in a successful `ack`; the
  climb is the budget accruing correctly. The gap was in who consults it.
- **The consultation now also happens at claim time**, gated on
  `blockOnError` and on `retry` **strictly greater** than `maxRetries`. Do not
  "fix" that to `>=`: a stream legitimately reaches `retry === maxRetries` on
  its final attempt and is entitled to run it. Only `>` is unreachable
  without lease loss.

Also settled: the losing worker can never repair this itself. Both `ack` and
`block` are gated on `leased_by = by`, so an evicted holder's writes are
no-ops by construction. Any fix has to run on the *next* holder, which is why
it lives at claim and not at ack.

**And a lesson about proving it.** The first version of this fix shipped with
tests that mocked `store.ack` to return `[]` and rewrote `retry` on the way
out of `claim` — they proved the guard fires when hand-fed the state, not that
the state ever occurs. The real reproduction lived in a throwaway probe that
got deleted. Lease theft is directly reproducible in a committed test: two
`Act` instances over one store, a handler parked on a promise the test
resolves, and a 1ms lease left to lapse. Deterministic (the park removes the
race; only expiry touches the clock) and it runs on InMemory and Postgres
alike. When a finding is about concurrency, the test has to contain the
concurrency — a mock of the losing side's return value is a restatement of
the hypothesis, not evidence for it.

