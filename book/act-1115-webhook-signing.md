# ACT-1115 — when receiver-side ergonomics earns sender-side work

## What this ticket actually closed

The original [ACT-1115](https://github.com/Rotorsoft/act-root/issues/743) was small: lift the case-insensitive `Idempotency-Key` parser out of `packages/server/src/idempotency.ts` and ship it from `@rotorsoft/act-http/receiver`. Twenty lines of code, five test cases, one new subpath. It would have been the third PR in the receiver-side migration sequence after [ACT-1118](./act-1118-idempotency-store.md) and [ACT-1119](./act-1119-retry-profile.md), completing the trajectory toward a fully library-housed receiver toolkit.

The PR that shipped did all of that, plus a meaningfully larger thing the original ticket didn't ask for: **paired HMAC-SHA256 signing on the sender and verification on the receiver**, designed and shipped together as the protocol future Act webhooks will use by default.

The interesting part of this ticket is the conversation that led there.

## The asymmetry argument, and the moment it stopped applying

When the question came up — *should we add HMAC signing to this PR?* — I argued against it twice in a row. The first time, with three reasons. The second time, with a corrected version of the same reasons. Both times I was honest, but both times I missed the actual question.

The reasons I gave were:

1. **The sender side doesn't support signing yet.** Shipping receiver-side `verifyHmacSignature` with no Act sender to validate against is asymmetric — we'd be building a receiver-side helper for *other* webhook senders (Stripe, GitHub, Slack-shaped tools), which is a different scope than the ACT-1110 mission of lifting demo code into libs.
2. **No tickets, no documented operator demand.** CLAUDE.md explicitly says don't design for hypothetical futures. The right path is "operator files a ticket; sender + receiver ship together later."
3. **Test surface explodes.** HMAC needs key fixtures, signing examples, canonicalization tests. Timestamp window needs clock-skew tests. That's a separate PR's worth of work.

All three were right *as far as they went*. The thing I missed: the user was *asking the question, not the answer*. They weren't asking "would you ship just the receiver verifier?" — they were asking "is the asymmetry worth fixing in this PR by doing both sides together?" Two messages in a row I answered the narrower question they hadn't asked, until the third try when they spelled it out: *implement the full protocol, webhook and receiver, in this ticket*.

The asymmetry argument doesn't refuse signing. It refuses *one-sided* signing. When the proposal becomes "ship the paired protocol," reason #1 evaporates — there's no asymmetry to refuse. Reasons #2 and #3 stay relevant as scoping constraints (don't ship key rotation, don't ship pluggable algorithms, don't ship vendor-compat layers), but they no longer rule out the work itself. They shape it.

The lesson is small but worth foregrounding for future tickets: when a single-sided primitive is rejected because its other side doesn't exist yet, the *other side appearing* is the unlock. Not "wait for separate tickets to slowly converge." If the project owner is in the room and willing to call the scope, the symmetric primitive can ship together. That's actually the *cleaner* path — both halves designed against each other, tested as a pair, documented as a contract.

## What "the protocol" had to mean

Before implementing, the design choices had to be surfaced and signed off on. A few looked harmless and weren't:

**Header names.** Generic `X-Webhook-Signature` + `X-Webhook-Timestamp`, vs. project-branded `X-Act-Webhook-*`. The generic pair matches the Stripe / GitHub / Slack convention modulo the prefix, so any operator who's wired a receiver before knows what to expect on first read. Project-branded would tie every signed webhook to Act's identity at the wire layer, which is overreach for an integration helper. Generic wins.

**Signature format.** `sha256=<hex>` with the algorithm prefix, GitHub-style. The prefix is *load-bearing*: it lets future versions add `sha512=` or `blake3=` to the same header without breaking the wire format. Stripe's bare-hex format closes that door. The cost of the four extra characters is rounding error compared to the option value of being able to upgrade the algorithm later.

**Body canonicalization.** Sign the *raw bytes that go over the wire* — for our helper, that's the `JSON.stringify` output of whatever the user's `body` resolver returned, or the literal string they passed. Any other choice would split: senders that re-canonicalize before signing differ from receivers that don't, and round-trip stops working. The constraint propagates outward: framework adapters in #744 must give the verifier access to the *raw* request body, not the parsed one. Document it sharply.

**Timestamp encoding.** Unix seconds as a string. Decimal, no leading zeros, parseable with `Number.parseInt`. Stripe-style. Anything else (milliseconds, ISO 8601, RFC 3339) adds a parser the receiver has to write, and the verifier already has to be careful about parseability — adding format complexity multiplies the failure modes.

**Default timestamp window.** `±300 seconds (5 min)`. The Stripe default, sized to accommodate NTP-synced clocks plus normal network latency. Configurable via `verifyWebhook(..., { maxAgeSeconds: ... })`. Two-sided (rejecting `future` as well as `stale`) — a request dated meaningfully in the future smells like clock manipulation and should fail closed.

**Unsigned mode is supported.** Omitting `secret` on the sender sends no signature headers, identical to the v1.0 helper's behaviour. The verifier on the receiver is opt-in per route — there's no global "all webhooks must be signed" switch. Back-compat with existing consumers, and lets services migrate piecewise.

The reasons-list for failure outcomes also got design attention. The verifier returns a discriminated union with five distinct reasons — `missing-signature`, `missing-timestamp`, `stale`, `future`, `bad-signature` — instead of a single boolean. Stripe's library does the same thing because each reason maps to a different operator action: lost-secret incidents look different from clock-drift incidents look different from active replay attempts. A boolean would collapse all three into one alarm. The five-reason taxonomy is the smallest set that supports honest telemetry.

## What was deferred, named, and parked

Even within "the full protocol," several features that would have looked tempting were left out by explicit choice. They got into the PR body and this book note so they don't drift into hidden expectations:

- **Multi-secret rotation.** Stripe accepts up to five active signatures during overlap to support rolling key rotation without dropped deliveries. Real need, but it adds an API dimension (`secrets: string[]`) and an iteration-order question (try all secrets vs. first match). Defer until an operator asks for it; meanwhile rotate by deploying both sides simultaneously.
- **Replay cache.** Proper replay protection beyond the timestamp window means remembering recently-seen signatures across the receiver's worker pool — i.e. an `IdempotencyStore.claim` keyed on the signature. The infrastructure for this exists in `@rotorsoft/act-ops/idempotency` already, but bolting it into `verifyWebhook` would couple two contracts that are cleaner kept separate. Operators who want replay protection beyond the window layer the dedup store on top, and the middleware in #744 will make that composition trivial.
- **Pluggable algorithms.** HMAC-SHA256 is universal. SHA-512, SHA-3, MAC-then-encrypt variants, all defensible in theory; none have a concrete consumer asking. The format prefix (`sha256=`) leaves the door open without committing to a configuration story today.
- **Vendor-compat layers.** Parsing `Stripe-Signature: t=...,v1=...` headers, or GitHub's `X-Hub-Signature-256`, is shipping a different protocol than ours. Out of scope.

The pattern repeats: a primitive earns its place when it has a documented consumer. When it doesn't, it stays in the doc as a deferred idea and waits for demand.

## What `act-http` looks like now

`@rotorsoft/act-http` has three subpaths after this PR. The shape is consistent: each subpath is a role, each role's primitives are the helpers a developer needs to play that role honestly.

- **`/webhook`** — sender role. POST, idempotency-key auto-derivation, status-classified retries, optional HMAC signing.
- **`/receiver`** — server role. Idempotency-key parsing, signature verification, framework-agnostic middleware (coming in #744), per-framework adapters (coming in #744).
- **`/sse`** — broadcast role. Channel, presence, state cache, patch applicator.

Each subpath stands alone — a service can install `act-http` and consume any one of the three without paying for the other two — but they're designed to *compose*. A typical Act-app server uses all three: outbound `webhook` reactions for downstream notifications, an inbound `/receiver` for events from upstream systems, and `/sse` for live state to its own clients. One package, three roles, paired primitives.

The shape is settled enough now that future tickets have clear homes. New helpers go to the subpath that matches their role. Helpers that don't have a subpath that matches earn one — but only when the role is real and the primitive is concrete. Speculative additions like "what about WebSocket receivers?" or "what about gRPC senders?" stay out until the consumer arrives.

## The closing trajectory

This was the third of three PRs that fully migrated the receiver-side idempotency story out of `packages/server` into libs: [ACT-1118](./act-1118-idempotency-store.md) shipped the port and reference implementation in `@rotorsoft/act-ops/idempotency`; [ACT-1119](./act-1119-retry-profile.md) shipped the TTL derivation and the subpath layout; this one shipped the inbound header parser and, as a bonus, the paired signing protocol. After it merges, `packages/server` contains zero reusable idempotency or receiver code. Every helper a real receiver needs lives in a library it can install.

The next ticket in the sequence is [ACT-1116](https://github.com/Rotorsoft/act-root/issues/744), the framework-agnostic middleware that wires all of these together for tRPC, Express, Fastify, and Hono. That ticket is now the *integration* ticket — every primitive it composes already exists. The work there is composition, not invention. That's how the helper-extraction story closes: the integration step has nothing left to invent because the inventions all landed in the preceding PRs.
