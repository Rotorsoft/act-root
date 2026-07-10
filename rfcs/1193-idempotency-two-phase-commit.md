# RFC 1193: two-phase commit for the receiver IdempotencyStore

- **Status:** accepted
- **Issue:** #1193
- **Author:** Rotorsoft
- **Created:** 2026-07-10

## Motivation

The receiver-side `IdempotencyStore` contract had a single verb — `claim(key)` —
that recorded the key durably the moment a request arrived, *before* the business
handler ran. Every receiver adapter (`receiver()`, and the raw Hono / Express /
Fastify / tRPC middlewares) ran the handler only when the claim was fresh.

That ordering silently drops deliveries. When a handler throws on a transient
fault the response is a 5xx, but the key is already claimed. The sender retries
with the same `Idempotency-Key`; the retry now sees a claimed key, is treated as
a duplicate, and returns a success with the handler skipped. Because the default
dedup window is deliberately sized to outlast the sender's whole retry envelope,
*every* retry lands inside the claimed window — one transient failure loses the
delivery permanently. (#1193, high severity.)

Operators can't work around it without abandoning the shipped store contract:
`claim` is the only method, and it commits on the first call.

## Public surface added

- **Port methods** on `IdempotencyStore` (`@rotorsoft/act-ops/idempotency`) — both
  **required**, both implemented by the in-tree `InMemoryIdempotencyStore`:
  - `commit(key: string, now?: number): void | Promise<void>` — promote a
    tentative `claim` to a durable record so later retries dedup.
  - `release(key: string): void | Promise<void>` — drop a still-tentative claim
    so a retry re-processes; a no-op once the key is committed.
  `claim`'s documented semantics narrow: the claim it makes is now **tentative**
  (dedups a concurrent duplicate mid-flight, but is not durable until committed).
- **Public types** (`@rotorsoft/act-http/receiver/*` subpaths):
  - `Finalizers` — `{ commit, release }` thunk pair bound to one delivery.
  - `ExpressIdempotency`, `FastifyIdempotency` — the `req.idempotency` /
    `request.idempotency` shape, now `{ key, deduped } & Finalizers`.
  - `WebhookVariables.idempotency` (Hono) gains `commit` / `release` fields.

## Alternatives considered

- **Do nothing / document the footgun.** Rejected: silent permanent data loss on
  a single transient fault is not a documentable caveat, it's the bug.
- **Handler-first, record-after-success (no `claim` reservation).** Runs the
  handler, records the key only on success. Rejected: it reintroduces the
  double-process race the original `claim` closed — a concurrent duplicate
  arriving mid-flight would both pass the "not seen yet" check and both run.
- **Cache the first response and replay it on a duplicate.** Rejected as
  over-engineering: it needs a response store and a serialization contract the
  receiver deliberately doesn't have ("ack the duplicate, do nothing else" is
  the standing convention). Doesn't fix the throw case — a cached 5xx is still a
  lost delivery.
- **`commit`/`release` as capability-gated optional methods.** Rejected: the
  whole fix depends on them, so gating them behind a capability flag would ship a
  store that still loses data by default. Making them required — with the one
  in-tree adapter implementing them in the same change — keeps the contract
  honest. `act-ops` is `0.x`, so the addition is provisional surface anyway.

## Stability / charter impact

- Category: **adapter contract** (`IdempotencyStore`) plus **public types** on the
  `act-http` receiver subpaths.
- **Additive.** No rename, removal, or narrowed type on existing surface. `claim`
  keeps its signature and return type; only its prose semantics tighten
  (tentative-until-committed), and existing callers that never retry-after-failure
  see identical behavior. No `BREAKING CHANGE:` footer.
- TCK / adapters: `act-ops` ships the only in-tree `IdempotencyStore`
  (`InMemoryIdempotencyStore`), updated here with unit coverage for the
  two-phase paths (commit-survives, release-frees, release-after-commit no-op,
  committed-entries-still-expire). No `runIdempotencyTck` exists yet; when a
  durable adapter and its TCK land (tracked for act-ops 1.2), the two-phase
  contract is the shape they conform to.

## Open questions

None.
