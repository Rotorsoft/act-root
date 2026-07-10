/**
 * @module autoclose-policy
 * @category Internal
 *
 * Declarative close-policy options consumed by `.autocloses({...})`
 * (#838 / epic #802). Three optional fields cover the three
 * operational pressure points every real close policy traces back to:
 *
 *   - `after`   — time / compliance ("autocloses **after** N days")
 *   - `is`      — domain lifecycle ("autocloses ... **is** Resolved")
 *   - `reaches` — resource ("autocloses ... **reaches** 10k events")
 *
 * Top-level fields combine with **AND** semantics. This captures the
 * common cooldown-after-terminal pattern that runs through almost
 * every business app — *"close 90 days after `Resolved`"*, *"close 14
 * days after `Delivered`"*, *"close 30 days after a GDPR deletion
 * request"*. All conditions must hold for the cycle to truncate.
 *
 * A separate `or: {...}` block opens an alternative path: when
 * present, the policy fires if **either** the top-level AND group
 * matches **or** any field inside `or` matches. Use it for safety
 * nets — *"close (Resolved AND aged 90 days) OR if event count
 * reaches 10k"*. The two-axis split mirrors the two ways close
 * policies appear in practice: primary close logic (AND-shaped) and
 * defensive backstops (OR-shaped).
 *
 * The state builder's `.autocloses(...)` overload distinguishes
 * function (predicate) from object (policy) and routes the latter
 * through {@link compile_autoclose_policy}, which validates via
 * {@link AutoclosePolicySchema} and returns the compiled predicate.
 * Operators with custom needs (per-stream metadata, multi-branch
 * AND/OR like "(`Resolved` + 90d) OR (`Cancelled` + 30d)") keep the
 * function form; the declarative form covers the 90% case.
 *
 * Validation runs at the builder call (`act().build()` time), so
 * misconfiguration — empty bag, sub-1 `reaches`, sub-minute `after`,
 * empty `is`, empty `or`, nested `or` inside `or`, unknown keys —
 * throws at build, not on the first cycle tick.
 *
 * @internal
 */

import { z } from "zod";
import type { AutoclosePredicate, Schemas } from "../types/action.js";

/**
 * One day in epoch milliseconds. The close surface is day-denominated
 * throughout — policies declare `{ days }`, the State carries
 * `autoclose_*_days`, and the reaction thinks in day offsets. This
 * constant (with {@link days_after} / {@link days_before_now}) is the
 * single place the closing process touches epoch arithmetic, because
 * `Date` itself has no other currency.
 */
const DAY_MS = 86_400_000;

/**
 * Lower bound on a resolved `after` window: one minute, expressed in
 * days. Sub-minute cooldowns are almost always misconfiguration.
 * Rejecting at build keeps the failure mode noisy.
 */
const MIN_AFTER_DAYS = 1 / 1440;

/**
 * Lower bound on a resolved `keep` window: one full day. The close
 * cycle is low-cadence, non-priority housekeeping — a rolling window
 * shorter than a day signals misconfiguration. Real retention
 * contracts (180 days, 7 years) are days and up.
 */
const MIN_KEEP_DAYS = 1;

/** The `Date` that lies `days` after `date`. @internal */
export function days_after(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** The `Date` that lies `days` in the past. @internal */
export function days_before_now(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

/**
 * Day-denominated window shared by `after` (terminate cooldown) and
 * `keep` (rolling retention). Fractional days accepted; windows below
 * the field's floor reject at build.
 *
 * @internal
 */
const window_schema = (
  field: "after" | "keep",
  min_days: number,
  floor: string
) =>
  z
    .object({
      days: z
        .number({ message: `autocloses: ${field}.days must be a number` })
        .positive(`autocloses: ${field}.days must be > 0`),
    })
    .refine((o) => o.days >= min_days, {
      message: `autocloses: ${field} resolves to < ${floor}, which is too short to be a meaningful retention window`,
    });

const AfterSchema = window_schema("after", MIN_AFTER_DAYS, "one minute");

const KeepSchema = window_schema("keep", MIN_KEEP_DAYS, "one day");

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
 * Schema for the `or: {...}` block — the OR-shaped alternative path.
 * Same field set as the top-level policy minus `or` itself (so nested
 * `or` inside `or` rejects via `.strict()` instead of recursing). At
 * least one field required; empty `{}` is a misconfiguration.
 *
 * @internal
 */
const OrBlockSchema = z
  .object({
    after: AfterSchema.optional(),
    is: IsSchema.optional(),
    reaches: ReachesSchema.optional(),
  })
  .strict()
  .refine(
    (o) =>
      o.after !== undefined || o.is !== undefined || o.reaches !== undefined,
    {
      message:
        "autocloses: `or` block must include at least one of after / is / reaches",
    }
  );

/**
 * Zod schema for the declarative {@link AutoclosePolicy} bag.
 * Internal `const` per the config-validation-schema standard (CLAUDE.md
 * "Config-validation schemas") — the public surface is the inferred
 * {@link AutoclosePolicy} type and the `.autocloses({...})` overload,
 * never this schema. `.strict()` rejects unknown keys so typos surface
 * at build instead of being silently ignored.
 *
 * @internal
 */
const AutoclosePolicySchema = z
  .object({
    after: AfterSchema.optional(),
    is: IsSchema.optional(),
    reaches: ReachesSchema.optional(),
    or: OrBlockSchema.optional(),
    keep: KeepSchema.optional(),
  })
  .strict()
  .refine(
    (o) =>
      o.after !== undefined ||
      o.is !== undefined ||
      o.reaches !== undefined ||
      o.or !== undefined ||
      o.keep !== undefined,
    {
      message:
        "autocloses: at least one of after / is / reaches / or / keep must be specified — empty `{}` is a misconfiguration",
    }
  );

/**
 * Declarative close-policy options consumed by `.autocloses({...})`.
 * Top-level fields are AND-combined; the optional `or` block opens an
 * alternative OR-path. Omitted fields contribute nothing — they do
 * not mean "match everything."
 *
 * @property after - Close when `head.created` is at least the resolved
 *   window in the past. Days are the close surface's only unit;
 *   fractional `days` cover sub-day cooldowns (`{ days: 1/24 }` is one
 *   hour) without introducing another denomination.
 * @property is - Close when `head.name` matches. String for the
 *   single-terminal-event case (the most common); `readonly string[]`
 *   for multi-terminal states (`Order: Shipped | Delivered |
 *   Cancelled`).
 * @property reaches - Close when the stream's event count is `>= N`
 *   (inclusive — fires the moment the threshold is reached).
 * @property or - Alternative OR-path. When present, the policy fires
 *   if EITHER the top-level AND group matches OR any field inside
 *   `or` matches. Used for safety-net backstops layered onto a
 *   primary cooldown policy (e.g. *"(Resolved AND 90 days) OR reaches
 *   10k"*). Nested `or` inside `or` rejects at build time.
 * @property keep - Rolling-window retention (#1011), **independent** of
 *   the terminate fields: while the stream stays open, prune events
 *   older than `now − keep` behind the closest safe snapshot via a
 *   windowed close. Does not participate in the AND group or the `or`
 *   block — a policy may terminate, prune, or both. Requires
 *   `.snap(...)` earlier in the builder chain (type-gated) and a
 *   window of at least one day — the close cycle is low-cadence
 *   housekeeping, never sub-day realtime.
 */
export type AutoclosePolicy = z.infer<typeof AutoclosePolicySchema>;

/** Compile a single `after` field into its predicate slice. @internal */
function compile_after(
  after: NonNullable<AutoclosePolicy["after"]>
): AutoclosePredicate<Schemas> {
  return (_stream, head) => days_after(head.created, after.days) <= new Date();
}

/** Compile a single `is` field into its predicate slice. @internal */
function compile_is(
  is: NonNullable<AutoclosePolicy["is"]>
): AutoclosePredicate<Schemas> {
  const set = new Set(typeof is === "string" ? [is] : is);
  return (_stream, head) => set.has(head.name as string);
}

/** Compile a single `reaches` field into its predicate slice. @internal */
function compile_reaches(
  reaches: NonNullable<AutoclosePolicy["reaches"]>
): AutoclosePredicate<Schemas> {
  return (_stream, _head, count) => count >= reaches;
}

/**
 * Compile a declarative {@link AutoclosePolicy} into an
 * {@link AutoclosePredicate}. The state-builder's
 * `.autocloses({...})` overload calls this; tests can also build a
 * state and read `state.autoclose` to grab the compiled predicate.
 *
 * Returned predicate fires when either:
 *
 *   1. **All** top-level non-`or` fields match (AND), or
 *   2. **Any** field inside the `or` block matches.
 *
 * Top-level with zero non-`or` fields never satisfies path (1) — the
 * `every` check on an empty list is short-circuited to `false` so the
 * policy doesn't truncate the entire universe on an `or`-only
 * declaration. (Validation rejects all-empty bags up front; this guard
 * is the in-cycle equivalent for the synthesized empty AND-group.)
 *
 * Assignable to any `AutoclosePredicate<TEvents>` slot via
 * function-parameter contravariance — the returned predicate inspects
 * `head.name` as a plain string, so narrower event unions stay
 * assignable.
 *
 * Throws `ZodError` at call time when the options are invalid (empty
 * bag, non-positive `reaches`, sub-minute `after`, empty `is`, empty
 * `or`, nested `or`, unknown keys).
 *
 * @internal
 */
/**
 * The smallest `after` window (in days) anywhere in a policy — across
 * the top-level `after` and the `or.after` block — or `undefined` when
 * the policy has no time component.
 *
 * The synthesized autoclose reaction (#1090) uses this to decide how to
 * wait: a policy with an `after` defers its re-check to `head.created`
 * plus this many days (the earliest its time gate could open); a policy
 * without one (`is` / `reaches` only) has no time gate, so the reaction
 * just waits for the next event to re-trigger rather than parking on a
 * due-time. Conservative — the min across branches never defers past
 * the soonest a branch could fire.
 *
 * @internal
 */
export function policy_min_after_days(
  options: AutoclosePolicy
): number | undefined {
  const parsed = AutoclosePolicySchema.parse(options);
  const windows: number[] = [];
  if (parsed.after) windows.push(parsed.after.days);
  if (parsed.or?.after) windows.push(parsed.or.after.days);
  return windows.length ? Math.min(...windows) : undefined;
}

/**
 * The rolling-window width (in days) of a policy's `keep` field, or
 * `undefined` when the policy declares no rolling window. The
 * synthesized autoclose reaction prunes the prefix older than the
 * window (via a windowed close) and derives its prune due-time as
 * `tail.created` plus this many days — the earliest the oldest
 * surviving domain event can age out of the window.
 *
 * @internal
 */
export function policy_keep_days(options: AutoclosePolicy): number | undefined {
  const parsed = AutoclosePolicySchema.parse(options);
  return parsed.keep?.days;
}

export function compile_autoclose_policy(
  options: AutoclosePolicy
): AutoclosePredicate<Schemas> {
  const parsed = AutoclosePolicySchema.parse(options);

  // Top-level AND group — only the non-`or` fields.
  const and_preds: AutoclosePredicate<Schemas>[] = [];
  if (parsed.after) and_preds.push(compile_after(parsed.after));
  if (parsed.is) and_preds.push(compile_is(parsed.is));
  if (parsed.reaches) and_preds.push(compile_reaches(parsed.reaches));

  // OR-block — at least one of its fields must match.
  const or_preds: AutoclosePredicate<Schemas>[] = [];
  if (parsed.or) {
    if (parsed.or.after) or_preds.push(compile_after(parsed.or.after));
    if (parsed.or.is) or_preds.push(compile_is(parsed.or.is));
    if (parsed.or.reaches) or_preds.push(compile_reaches(parsed.or.reaches));
  }

  return (stream, head, count) => {
    // AND path: every top-level field matches AND the group is non-empty
    // (an `or`-only declaration leaves `and_preds` empty — that
    // shouldn't auto-fire).
    if (
      and_preds.length > 0 &&
      and_preds.every((p) => p(stream, head, count))
    ) {
      return true;
    }
    // OR path: any `or`-block field matches.
    if (or_preds.some((p) => p(stream, head, count))) {
      return true;
    }
    return false;
  };
}
