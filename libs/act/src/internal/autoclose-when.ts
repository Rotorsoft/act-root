/**
 * @module autoclose-when
 * @category Internal
 *
 * The `when({...})` close-policy factory (#838 / epic #802). Collapses
 * the originally-scoped trio of policy factories (retention #838,
 * terminal #839, cardinality #840) into a single declarative builder
 * with OR semantics across optional fields, so real-world policies
 * that stack ("close on `Resolved` OR after 2y retention OR at 10k
 * events") express as one object literal instead of a chain of
 * `anyOf(retention(...), terminal(...), cardinality(...))` calls.
 *
 * The three field choices map to the three operational pressure points
 * every close policy traces back to:
 *
 *   - `olderThan`  — time / compliance ("old data is irrelevant or
 *     non-compliant")
 *   - `on`         — domain lifecycle ("the aggregate reached a
 *     terminal state, no more events expected")
 *   - `count`      — resource ("this stream is growing unbounded and
 *     will blow up reducer cost or storage")
 *
 * Anything beyond these falls back to the function form
 * `.autocloses((stream, head, count) => ...)`. The factory covers the
 * 90% case declaratively; the predicate form keeps the long tail open.
 *
 * Validation runs at factory-call time via {@link WhenOptionsSchema}
 * (same Zod-as-config standard as `AutocloseOptionsSchema` /
 * `SseOptionsSchema` / `OpenAPIOptionsSchema`), so misconfiguration
 * (`when({})`, `count: 0`, sub-minute `olderThan`) throws before
 * `act().build()`.
 *
 * @internal
 */

import { z } from "zod";
import type { AutoclosePredicate, Schemas } from "../types/action.js";

/**
 * Lower bound on a resolved `olderThan` window. Predicates with
 * sub-minute windows are almost always misconfiguration — the cycle
 * tick itself runs at the order of `autocloseCycleMs` (default 60 s),
 * so a 30 s window can't be honored anyway. Rejecting at build keeps
 * the failure mode noisy.
 */
const MIN_OLDER_THAN_MS = 60_000;

const OlderThanSchema = z
  .object({
    days: z
      .number({ message: "when: olderThan.days must be a number" })
      .positive("when: olderThan.days must be > 0"),
  })
  .refine((o) => o.days * 86_400_000 >= MIN_OLDER_THAN_MS, {
    message: `when: olderThan resolves to < ${MIN_OLDER_THAN_MS}ms (one minute), which is too short to be a meaningful retention window`,
  });

const OnSchema = z.union([
  z.string().min(1, "when: on must be a non-empty event name"),
  z
    .array(z.string().min(1, "when: on entries must be non-empty event names"))
    .min(1, "when: on must include at least one event name")
    .readonly(),
]);

const CountSchema = z
  .number({ message: "when: count must be a number" })
  .int("when: count must be an integer")
  .min(1, "when: count must be >= 1");

/**
 * Zod schema for {@link when}'s options bag. Internal `const` per the
 * config-validation-schema standard (CLAUDE.md "Config-validation
 * schemas") — the public surface is {@link WhenOptions} + {@link when}.
 *
 * @internal
 */
const WhenOptionsSchema = z
  .object({
    olderThan: OlderThanSchema.optional(),
    on: OnSchema.optional(),
    count: CountSchema.optional(),
  })
  .refine(
    (o) =>
      o.olderThan !== undefined || o.on !== undefined || o.count !== undefined,
    {
      message:
        "when: at least one of olderThan / on / count must be specified — empty `when({})` is a misconfiguration",
    }
  );

/**
 * Declarative close-policy options consumed by {@link when}. Each
 * field is optional; the resulting predicate ORs together every
 * provided field. Omitted fields contribute nothing — they do not
 * mean "match everything."
 *
 * @property olderThan - Close when `head.created` is strictly older
 *   than the resolved window. Nested object leaves room for `hours`
 *   / `ms` units later without polluting the top level.
 * @property on - Close when `head.name` matches. String for the
 *   single-terminal-event case (the most common); `readonly string[]`
 *   for multi-terminal states (`Order: Shipped | Delivered |
 *   Cancelled`).
 * @property count - Close when the stream's event count is `>= N`
 *   (inclusive — fires the moment the threshold is reached).
 */
export type WhenOptions = z.infer<typeof WhenOptionsSchema>;

/**
 * Build a close-policy predicate from a declarative options bag.
 *
 * Returns an {@link AutoclosePredicate} that yields `true` when **any**
 * of the configured fields matches. Assignable to any
 * `AutoclosePredicate<TEvents>` slot via function-parameter
 * contravariance — the returned predicate inspects `head.name` as a
 * plain string, so narrower event unions stay assignable.
 *
 * Throws `ZodError` at call time when the options are invalid (empty
 * bag, non-positive count, sub-minute `olderThan`, etc.).
 *
 * @example Time-based retention
 * ```ts
 * .autocloses(when({ olderThan: { days: 90 } }))
 * ```
 *
 * @example Terminal event
 * ```ts
 * .autocloses(when({ on: "Resolved" }))
 * .autocloses(when({ on: ["Shipped", "Delivered", "Cancelled"] }))
 * ```
 *
 * @example Cardinality cap
 * ```ts
 * .autocloses(when({ count: 10_000 }))
 * ```
 *
 * @example Stacked policy (OR across the three pressure points)
 * ```ts
 * .autocloses(when({
 *   olderThan: { days: 730 },   // 2-year retention
 *   on: "Resolved",             // OR explicit close
 *   count: 10_000,              // OR cardinality blow-up guard
 * }))
 * ```
 */
export function when(options: WhenOptions): AutoclosePredicate<Schemas> {
  const parsed = WhenOptionsSchema.parse(options);
  const older_than_ms = parsed.olderThan
    ? parsed.olderThan.days * 86_400_000
    : undefined;
  const on_set = parsed.on
    ? new Set(typeof parsed.on === "string" ? [parsed.on] : parsed.on)
    : undefined;
  const count_threshold = parsed.count;

  return (_stream, head, count) => {
    if (
      older_than_ms !== undefined &&
      Date.now() - head.created.getTime() >= older_than_ms
    ) {
      return true;
    }
    if (on_set !== undefined && on_set.has(head.name as string)) {
      return true;
    }
    if (count_threshold !== undefined && count >= count_threshold) {
      return true;
    }
    return false;
  };
}
