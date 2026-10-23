/**
 * The transforms that apply the sensitive-data marker (`../sensitive.ts`):
 * split sensitive fields out at commit, gate them on read, and strip them
 * before projection and reaction handlers.
 */

import type { Actor, Committed, Schemas } from "../types/index.js";
import { REDACTED, SHREDDED } from "../types/schemas.js";

/**
 * Split an emitted event's `data` into `data` (non-sensitive) + `pii`
 * (sensitive) using the field list precomputed at build time. Called by the
 * state's `message` hook (`event-builder.ts`) on the way to `Store.commit`,
 * and only for events that declare sensitive fields.
 */
export function pii_split<TName, TData extends Record<string, unknown>>(
  emitted: { name: TName; data: TData },
  fields: readonly string[]
): { name: TName; data: TData; pii: Record<string, unknown> } {
  const data = { ...emitted.data };
  const pii: Record<string, unknown> = {};
  for (const f of fields) {
    if (f in data) {
      pii[f] = data[f];
      delete data[f];
    }
  }
  return { name: emitted.name, data, pii };
}

/**
 * Build the **external view** of a committed event — the form returned by
 * `load()`, `query()`, `query_array()`, and the snapshot in `do()`'s reply.
 *
 * Only ever reached for events that declare sensitive fields — the sole caller
 * is {@link make_gate}, which the builder invokes exclusively for sensitive
 * events; non-sensitive events short-circuit to {@link IDENTITY_GATE} before
 * they get here. `fields` is therefore guaranteed non-empty (same contract as
 * {@link pii_strip}).
 *
 * - Event whose `pii` payload is null/undefined → substitute {@link SHREDDED}
 *   for each declared field. Irrecoverable, so no predicate check.
 * - Event with a `pii` payload, predicate returns `true` → merge `pii` into
 *   `data` (plaintext).
 * - Event with a `pii` payload, predicate returns `false` OR no predicate
 *   declared (framework default-deny) → substitute {@link REDACTED} for each
 *   declared field.
 */
function pii_gate<TEvents extends Schemas, TKey extends keyof TEvents>(
  event: Committed<TEvents, TKey>,
  fields: readonly string[],
  predicate: ((event: any, actor: Actor) => boolean) | null,
  actor: Actor | undefined
): Committed<TEvents, TKey> {
  const data = event.data as Record<string, unknown>;
  // The external view never carries the isolated `pii` sidecar: keeping it
  // would leak plaintext on every gated read (`load`, `query`,
  // `query_array`) even while `data` is redacted. The plaintext lives in
  // `data` only on the authorized path.
  const { pii, ...rest } = event as Committed<TEvents, TKey> & {
    pii?: Record<string, unknown> | null;
  };
  if (pii == null) {
    const shredded: Record<string, unknown> = { ...data };
    for (const f of fields) shredded[f] = SHREDDED;
    return { ...rest, data: shredded as Committed<TEvents, TKey>["data"] };
  }
  // Plaintext path requires both an actor AND a predicate that allows. Missing
  // either → default-deny → REDACTED.
  const allowed = !!actor && !!predicate && predicate(event, actor);
  if (allowed) {
    return {
      ...rest,
      data: { ...data, ...pii } as Committed<TEvents, TKey>["data"],
    };
  }
  const redacted: Record<string, unknown> = { ...data };
  for (const f of fields) redacted[f] = REDACTED;
  return { ...rest, data: redacted as Committed<TEvents, TKey>["data"] };
}

/**
 * A prebuilt per-event read gate: given a committed event and the reading
 * actor, return the caller-visible form. This is the single gating primitive
 * the builder prebuilds for **every** read surface — both the actor-less
 * `query` / `query_array` (which pass no actor → default-deny) and the
 * actor-aware `load` / `do`-return view (which pass the reader). Non-sensitive
 * events use the shared {@link IDENTITY_GATE}; sensitive events use a redactor
 * built by {@link make_gate} that closes over the field list and the state's
 * disclosure predicate, so the read path never recomputes the sensitive-field
 * lookup nor allocates per event.
 *
 * The `actor` is optional so the actor-less surfaces can call `gate(event)`.
 */
export type EventGate = <TEvents extends Schemas, TKey extends keyof TEvents>(
  event: Committed<TEvents, TKey>,
  actor?: Actor
) => Committed<TEvents, TKey>;

/**
 * Shared zero-cost gate for every event with no `sensitive(...)` fields — a
 * single frozen reference the builder hands back for non-sensitive events, so
 * the common path is one `Map` miss and an identity call, no allocation. This
 * is the "by default, return the event" half of the prebuilt per-event gate.
 */
export const IDENTITY_GATE: EventGate = (event) => event;

/**
 * Prebuild a read gate for a sensitive event, capturing its field list and the
 * disclosure predicate once at build time. The returned closure defers to
 * {@link pii_gate} with the reading actor supplied per call:
 *
 * - `predicate = null` (the actor-less `query` surfaces, or a state that never
 *   declared `.discloses`) → default-deny: declared fields come back
 *   {@link REDACTED} (or {@link SHREDDED} once the pii column is forgotten).
 * - `predicate` set + an authorized actor → plaintext merged into `data`.
 *
 * Either way the isolated `pii` sidecar is dropped. The builder stores one gate
 * per sensitive event (per state for the load path; predicate-less for the
 * query path); non-sensitive events fall back to {@link IDENTITY_GATE}.
 */
export function make_gate(
  fields: readonly string[],
  predicate: ((event: any, actor: Actor) => boolean) | null
): EventGate {
  return (event, actor) => pii_gate(event, fields, predicate, actor);
}

/**
 * Build the **handler view** — sensitive keys removed entirely from `data`
 * and the `pii` field dropped from the event. Used before invoking projection
 * handlers and reaction handlers, which never see PII by framework rule.
 *
 * Different from {@link pii_gate} (which substitutes {@link REDACTED} or
 * {@link SHREDDED}) — projection tables and reaction sinks shouldn't even
 * structurally observe the keys, so a handler that mistakenly writes
 * `event.data.email` into a column would get `undefined`, not a sentinel
 * string that looks like real data. The strictness is deliberate.
 *
 * Reactions that genuinely need PII (e.g. a welcome-email reaction reading
 * `email`) opt back in by explicitly calling `app.load(stream, { actor:
 * system_actor })` inside the handler — pulling PII through the gate at the
 * call site makes the security-relevant path visible in code review.
 */
export function pii_strip<
  TEvents extends Schemas,
  TKey extends keyof TEvents & string,
>(
  event: Committed<TEvents, TKey>,
  fields: readonly string[]
): Committed<TEvents, TKey> {
  // Contract: `fields` is non-empty. The event gate (`event-builder.ts`) and
  // the projection fold (`projection-fold.ts`) call it only when it is.
  const data = event.data as Record<string, unknown>;
  const stripped: Record<string, unknown> = {};
  for (const k of Object.keys(data)) {
    if (!fields.includes(k)) stripped[k] = data[k];
  }
  const { pii: _drop_pii, ...rest } = event as Committed<TEvents, TKey> & {
    pii?: unknown;
  };
  return {
    ...rest,
    data: stripped as Committed<TEvents, TKey>["data"],
  } as Committed<TEvents, TKey>;
}
