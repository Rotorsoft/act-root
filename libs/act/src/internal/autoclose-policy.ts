/**
 * Compiles the declarative `.autocloses({...})` policy into a predicate.
 * Top-level `after` / `is` / `reaches` combine with AND; an `or: {...}`
 * block adds an alternative path. Validated with
 * the `autoclose_policy` bag in `config.ts` when the app builds, so a bad policy throws
 * then, not on the first cycle. Semantics and examples:
 * docs/docs/guides/close-policies.md.
 */

import type {
  AutoclosePolicy,
  AutoclosePredicate,
  Schemas,
} from "../types/action.js";
import { check } from "./config.js";

/**
 * One day in epoch milliseconds. The close surface is day-denominated
 * throughout — policies declare `{ days }`, the State carries
 * `autoclose_*_days`, and the reaction thinks in day offsets. This
 * constant (with {@link days_after} / {@link days_before_now}) is the
 * single place the closing process touches epoch arithmetic, because
 * `Date` itself has no other currency.
 */
const DAY_MS = 86_400_000;

/** The `Date` that lies `days` after `date`. */
export function days_after(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** The `Date` that lies `days` in the past. */
export function days_before_now(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

/** Compile a single `after` field into its predicate slice. */
function compile_after(
  after: NonNullable<AutoclosePolicy["after"]>
): AutoclosePredicate<Schemas> {
  return (_stream, head) => days_after(head.created, after.days) <= new Date();
}

/** Compile a single `is` field into its predicate slice. */
function compile_is(
  is: NonNullable<AutoclosePolicy["is"]>
): AutoclosePredicate<Schemas> {
  const set = new Set(typeof is === "string" ? [is] : is);
  return (_stream, head) => set.has(head.name as string);
}

/** Compile a single `reaches` field into its predicate slice. */
function compile_reaches(
  reaches: NonNullable<AutoclosePolicy["reaches"]>
): AutoclosePredicate<Schemas> {
  return (_stream, _head, count) => count >= reaches;
}

/**
 * Every `after` window (in days) in a policy. The reaction parks on the
 * earliest one still ahead, so a branch with a later window keeps its turn once
 * an earlier one has passed.
 */
export function policy_after_windows(options: AutoclosePolicy): number[] {
  const parsed = check("autoclose_policy", options);
  return [parsed.after, parsed.or?.after].flatMap((w) => (w ? [w.days] : []));
}

/**
 * The rolling-window width (in days) of a policy's `keep` field, or
 * `undefined` when the policy declares no rolling window. The
 * synthesized autoclose reaction prunes the prefix older than the
 * window (via a windowed close) and derives its prune due-time as
 * `tail.created` plus this many days — the earliest the oldest
 * surviving domain event can age out of the window.
 */
export function policy_keep_days(options: AutoclosePolicy): number | undefined {
  const parsed = check("autoclose_policy", options);
  return parsed.keep?.days;
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
 */
export function compile_autoclose_policy(
  options: AutoclosePolicy
): AutoclosePredicate<Schemas> {
  const parsed = check("autoclose_policy", options);

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
