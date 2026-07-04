# RFC 1120: skip oversize NOTIFY payloads in `PostgresStore.commit`

- **Status:** draft <!-- draft | accepted | rejected | superseded -->
- **Issue:** #1120
- **Author:** Claude (with Rotorsoft)
- **Created:** 2026-07-04

> Gate-driven RFC: the rfc-gate fired because the stability snapshot grew, but
> the growth is comment text plus an internal guard inside an existing method
> body — no new public surface. Filed per the gate's own "when in doubt, open
> the RFC" remedy for false positives; kept to the sections that apply.

## Motivation

PostgreSQL rejects NOTIFY payloads at or above 8000 bytes (`payload string
too long`), and `PostgresStore.commit()` issues `pg_notify` inside the commit
transaction when `config.notify` is on. #1120's conformance tests exposed
that an oversize payload (a large batch, or long stream/event names — ~75+
events at varchar(100)-scale names) aborted the whole INSERT batch: the
commit threw and the events were rolled back, contradicting the code's own
comment that "the polling fallback path handles the rare overflow case."
The fix measures the serialized payload first and skips the NOTIFY when it
would not fit — the commit succeeds, listeners fall back to the poll path,
and delivery degrades in latency, never in guarantees.

## Public surface added

None. The change is entirely inside `PostgresStore.commit()`: a module-level
internal constant (`NOTIFY_MAX_PAYLOAD_BYTES`, not exported) and a byte-length
guard around the existing `pg_notify` call. No new export, builder method,
port method, lifecycle event, or public type. The snapshot grew only because
the stability TCK captures source text, and the fix carries explanatory
comments.

## Alternatives considered

- **Do nothing / pin the throwing behavior.** Rejected — losing a committed
  batch because a latency optimization overflowed is not sane behavior, and
  it violates the at-least-once contract NOTIFY is documented to sit on top
  of (`cross-process-reactions.md`).
- **try/catch around `pg_notify`.** Doesn't work: the error aborts the open
  transaction, so the subsequent `COMMIT` fails anyway. The guard has to run
  before the statement.
- **Emit a truncated / "overflow marker" notification.** Rejected as new
  wire-format surface for a rare case the poll path already covers; listeners
  would need to learn a second payload shape.

## Stability / charter impact

Adapter implementation detail — explicitly out of charter scope
(STABILITY.md § Not covered). Purely a bug fix (`fix(act-pg)`), no breaking
change, no TCK impact (NOTIFY semantics are outside the shared TCK; the
behavior is pinned by `libs/act-pg/test/notify.contract.spec.ts` and two new
rows in `docs/docs/architecture/behavior-contracts.md`).

## Open questions

None.
