/**
 * @module autoclose-policy
 * @category Internal
 *
 * Declarative close-policy options consumed by `.autocloses({...})`
 * (#838 / epic #802). Three optional fields cover the three operational
 * pressure points every real close policy traces back to:
 *
 *   - `after`   — time / compliance ("autocloses **after** N days")
 *   - `is`      — domain lifecycle ("autocloses ... **is** Resolved")
 *   - `reaches` — resource ("autocloses ... **reaches** 10k events")
 *
 * The verb-shaped field names let `.autocloses({...})` read like a
 * sentence at the call site: `.autocloses({ after: { days: 90 }, is:
 * "Resolved", reaches: 10_000 })` reads "autocloses after 90 days, is
 * Resolved, reaches 10k." Each field is independent; the resulting
 * predicate ORs them together (a true match on any field is enough).
 *
 * The state builder's `.autocloses(...)` overload distinguishes
 * function (predicate) from object (policy) and routes the latter
 * through {@link compile_autoclose_policy}, which validates via
 * {@link AutoclosePolicySchema} and returns the compiled predicate.
 * Operators with custom needs (per-stream metadata, AND-composition)
 * keep the function form; the declarative form covers the 90% case.
 *
 * Validation runs at the builder call (`act().build()` time), so
 * misconfiguration — empty bag, sub-1 `reaches`, sub-minute `after`,
 * empty `is` — throws at build, not on the first cycle tick.
 *
 * @internal
 */

import { z } from "zod";
import type { AutoclosePredicate, Schemas } from "../types/action.js";

/**
 * Lower bound on a resolved `after` window. Sub-minute windows are
 * almost always misconfiguration — the autoclose cycle ticks at the
 * order of `autocloseCycleMs` (default 60 s), so a 30 s window can't
 * be honored anyway. Rejecting at build keeps the failure mode noisy.
 */
const MIN_AFTER_MS = 60_000;

const AfterSchema = z
  .object({
    days: z
      .number({ message: "autocloses: after.days must be a number" })
      .positive("autocloses: after.days must be > 0"),
  })
  .refine((o) => o.days * 86_400_000 >= MIN_AFTER_MS, {
    message: `autocloses: after resolves to < ${MIN_AFTER_MS}ms (one minute), which is too short to be a meaningful retention window`,
  });

const IsSchema = z.union([
  z.string().min(1, "autocloses: is must be a non-empty event name"),
  z
    .array(
      z.string().min(1, "autocloses: is entries must be non-empty event names")
    )
    .min(1, "autocloses: is must include at least one event name")
    .readonly(),
]);

const ReachesSchema = z
  .number({ message: "autocloses: reaches must be a number" })
  .int("autocloses: reaches must be an integer")
  .min(1, "autocloses: reaches must be >= 1");

/**
 * Zod schema for the declarative {@link AutoclosePolicy} bag.
 * Internal `const` per the config-validation-schema standard (CLAUDE.md
 * "Config-validation schemas") — the public surface is the inferred
 * {@link AutoclosePolicy} type and the `.autocloses({...})` overload,
 * never this schema.
 *
 * @internal
 */
const AutoclosePolicySchema = z
  .object({
    after: AfterSchema.optional(),
    is: IsSchema.optional(),
    reaches: ReachesSchema.optional(),
  })
  .refine(
    (o) =>
      o.after !== undefined || o.is !== undefined || o.reaches !== undefined,
    {
      message:
        "autocloses: at least one of after / is / reaches must be specified — empty `{}` is a misconfiguration",
    }
  );

/**
 * Declarative close-policy options consumed by `.autocloses({...})`.
 * Each field is optional; the resulting predicate ORs together every
 * provided field. Omitted fields contribute nothing — they do not mean
 * "match everything."
 *
 * @property after - Close when `head.created` is at least the resolved
 *   window in the past. Nested object leaves room for `hours` / `ms`
 *   units later without polluting the top level. Fractional `days`
 *   accepted (`{ days: 1/24 }` is 1 hour) so sub-day windows work.
 * @property is - Close when `head.name` matches. String for the
 *   single-terminal-event case (the most common); `readonly string[]`
 *   for multi-terminal states (`Order: Shipped | Delivered |
 *   Cancelled`).
 * @property reaches - Close when the stream's event count is `>= N`
 *   (inclusive — fires the moment the threshold is reached).
 */
export type AutoclosePolicy = z.infer<typeof AutoclosePolicySchema>;

/**
 * Compile a declarative {@link AutoclosePolicy} into an
 * {@link AutoclosePredicate}. The state-builder's
 * `.autocloses({...})` overload calls this; tests can also build a
 * state and read `state.autoclose` to grab the compiled predicate.
 *
 * Returned predicate yields `true` when **any** of the configured
 * fields matches. Assignable to any `AutoclosePredicate<TEvents>`
 * slot via function-parameter contravariance — it inspects
 * `head.name` as a plain string, so narrower event unions stay
 * assignable.
 *
 * Throws `ZodError` at call time when the options are invalid (empty
 * bag, non-positive `reaches`, sub-minute `after`, empty `is`).
 *
 * @internal
 */
export function compile_autoclose_policy(
  options: AutoclosePolicy
): AutoclosePredicate<Schemas> {
  const parsed = AutoclosePolicySchema.parse(options);
  const after_ms = parsed.after ? parsed.after.days * 86_400_000 : undefined;
  const is_set = parsed.is
    ? new Set(typeof parsed.is === "string" ? [parsed.is] : parsed.is)
    : undefined;
  const reaches_threshold = parsed.reaches;

  return (_stream, head, count) => {
    if (
      after_ms !== undefined &&
      Date.now() - head.created.getTime() >= after_ms
    ) {
      return true;
    }
    if (is_set !== undefined && is_set.has(head.name as string)) {
      return true;
    }
    if (reaches_threshold !== undefined && count >= reaches_threshold) {
      return true;
    }
    return false;
  };
}
