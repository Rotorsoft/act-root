/**
 * Every option bag act-core accepts, checked in one place. Each bag has an
 * internal schema below; `check(kind, options)` parses it, throws `ZodError`
 * on a bad value and returns the parsed, defaulted bag, which a caller that
 * only needs the throw ignores. Validation refuses only what is broken
 * (`NaN`, `±Infinity`, nonsensical negatives) and never newly refuses a
 * value that works. The rules are in .claude/rules/config-validation.md.
 */

import { z } from "zod";
import type { AutocloseConfig, CircuitBreakerOptions } from "../types/act.js";
import type { AutoclosePolicy, BackoffOptions } from "../types/index.js";
import { MAX_TIMER_DELAY_MS } from "./defer-timer.js";

// Backoff — retry pacing, nested in the reaction and action bags. No
// `maxMs >= baseMs` constraint: a cap below `baseMs` on `exponential` is
// documented behavior.
const BackoffOptionsSchema = z.object({
  strategy: z.enum(["fixed", "linear", "exponential"]),
  baseMs: z.number().min(0),
  maxMs: z.number().gt(0).optional(),
  jitter: z.boolean().optional(),
});

/**
 * Retry pacing for a reaction that declares no backoff, and for projections
 * and failed fetches, which have no options. Ten seconds, like the default
 * lease; the lease itself only keeps two workers off one stream.
 */
export const DEFAULT_BACKOFF: BackoffOptions = {
  strategy: "fixed",
  baseMs: 10_000,
};

// Reaction — `.do(handler, options)`, fully defaulted by the builder.
// `maxRetries` gates the block decision, so a `NaN` would retry a poison
// message forever.

/** Retries a reaction gets before it blocks, unless `.do()` says otherwise. */
export const DEFAULT_MAX_RETRIES = 3;
/** Whether a reaction blocks its stream once retries run out. */
export const DEFAULT_BLOCK_ON_ERROR = true;

const ReactionOptionsSchema = z.object({
  blockOnError: z.boolean(),
  maxRetries: z.number().int().min(0),
  backoff: BackoffOptionsSchema.optional(),
});

// Action — `.on(entry, options)`. `maxRetries` ends the command retry loop,
// so a `NaN` could spin it forever on a contended stream.
const ActionOptionsSchema = z.object({
  maxRetries: z.number().int().min(0).optional(),
  backoff: BackoffOptionsSchema.optional(),
});

// Target — `.to({ target, priority })`, a resolver's result and
// `app.prioritize`. Postgres stores `priority` as a 32-bit `int`.
const TargetOptionsSchema = z.object({ priority: z.int32().optional() });

// Restore — `app.restore(source, options)`. The stores read a falsy limit as
// "no limit", so a NaN or 0 page reads the whole source at once, and a
// negative or fractional one ends the scan early, after the sink was wiped.
const ScanOptionsSchema = z.object({
  batch_size: z.number().int().min(1).optional(),
});

// Audit — `app.audit(categories, options)`. A NaN cutoff fails every
// comparison, so it would report a clean store.
const AuditOptionsSchema = z.object({
  thresholds: z
    .object({
      idle_days: z.number().min(0).optional(),
      restart_min: z.number().min(0).optional(),
      stuck_minutes: z.number().min(0).optional(),
      near_block: z.number().min(0).optional(),
      deprecated_min: z.number().min(0).optional(),
      drift_min: z.number().min(0).optional(),
    })
    .optional(),
});

// A timer's delay. Node runs a timer below 1 ms, above 2^31 − 1 ms or NaN
// every millisecond, so every delay a bag sets a timer from is held to this.
const TimerMsSchema = z.number().min(0).max(MAX_TIMER_DELAY_MS);

// Page — the `limit` and bounds of every query: `app.query`, `app.load`'s
// `asOf`, `app.correlate`, `app.start_correlations`, `app.blocked_streams`
// and settle's `correlate`. 0 stays (the poll reads it as its default); a NaN
// limit read the whole log, and a NaN or Invalid Date bound was ignored by
// one store and threw a raw driver error in another.
const LimitSchema = z.number().int().min(0).optional();
const PageOptionsSchema = z.object({
  limit: LimitSchema,
  before: z.number().optional(),
  after: z.number().optional(),
  created_before: z.date().optional(),
  created_after: z.date().optional(),
});

// Poll — `app.start_correlations`' frequency.
const PollOptionsSchema = z.object({
  frequency: TimerMsSchema,
});

// Drain / Settle — the knobs of `app.drain(...)` and `app.settle(...)`.

/** Streams a drain claims per cycle. */
export const DEFAULT_STREAM_LIMIT = 10;
/** Events a drain reads per stream per cycle. */
export const DEFAULT_EVENT_LIMIT = 10;
/** How long a drain holds a stream's lease (ms). */
export const DEFAULT_LEASE_MILLIS = 10_000;

// A drain claims at least one stream: 0 would claim nothing and read as
// caught up, so the lane would never run.
const DrainOptionsSchema = z.object({
  streamLimit: z.number().int().min(1).optional(),
  eventLimit: z.number().int().min(0).optional(),
  leaseMillis: z.number().min(0).optional(),
});

// Lane — `.withLane({...})`, per-lane overrides of the drain budget.
const LaneConfigSchema = DrainOptionsSchema.pick({
  streamLimit: true,
  leaseMillis: true,
}).extend({
  name: z.string().min(1),
  cycleMs: TimerMsSchema.optional(),
});

const SettleOptionsSchema = DrainOptionsSchema.extend({
  debounceMs: TimerMsSchema.optional(),
  correlate: PageOptionsSchema.optional(),
  // `0` runs no passes; `Infinity` is the documented default (no cap), which
  // an integer check alone would refuse.
  maxPasses: z
    .union([z.number().int().min(0), z.literal(Number.POSITIVE_INFINITY)])
    .optional(),
});

// Shutdown — the grace budget `app.shutdown(...)` gives in-flight cycles.

/**
 * Ceiling on the derived shutdown grace budget, so one parked handler on a
 * long-lease lane can't hold a rolling deploy open for that whole lease. 30s
 * is the longest `leaseMillis` the production checklist recommends.
 */
export const MAX_SHUTDOWN_GRACE_MS = 30_000;

// `0` stops scheduling and returns without waiting.
const ShutdownOptionsSchema = z.object({
  graceMs: TimerMsSchema.optional(),
});

// Act — the scalar knobs of `act().build(options)`. The autoclose window and
// the circuit breaker are their own bags below.
const ActOptionsSchema = z.object({
  maxSubscribedStreams: z.number().int().min(1).optional(),
  settleDebounceMs: TimerMsSchema.int().optional(),
  autoSettle: z.boolean().optional(),
});

// Autoclose window — `ActOptions.autocloseWindow`, the off-hours window. The
// hour math stays in `autoclose-window.ts`.

/** True when `tz` is a zone the runtime's `Intl` accepts. */
function is_time_zone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const hour = (field: string) =>
  z
    .number()
    .int()
    .min(0)
    .max(23, {
      message: `autocloseWindow.${field} must be an hour in [0, 23]`,
    });

const AutocloseOptionsSchema = z.object({
  autocloseWindow: z
    .object({
      start: hour("start"),
      end: hour("end"),
      timeZone: z
        .string()
        .refine(is_time_zone, {
          message: "autocloseWindow.timeZone must be a valid IANA time zone",
        })
        .default("UTC"),
    })
    .refine((w) => w.start !== w.end, {
      message:
        "autocloseWindow.start and end must differ — an empty window disables autoclose",
    })
    .optional(),
}) satisfies z.ZodType<AutocloseConfig>;

// Circuit breaker — `ActOptions.circuitBreaker`, the store-op breaker. The
// state machine stays in `circuit-breaker.ts`.
const CircuitBreakerOptionsSchema = z.object({
  failureThreshold: z.number().int().min(1).default(5),
  cooldownMs: z.number().int().min(100).max(3_600_000).default(30_000),
}) satisfies z.ZodType<CircuitBreakerConfig, CircuitBreakerOptions>;

/** Resolved circuit-breaker configuration. */
export type CircuitBreakerConfig = Required<CircuitBreakerOptions>;

// Fold — the batch-fold knobs of `projection(name).of(state, options)`.
const FoldOptionsSchema = z.object({
  flushEvery: z.number().int().min(1).default(1_000),
  maxCachedStates: z.number().int().min(1).default(10_000),
});

/** Resolved fold configuration. */
export type FoldConfig = z.infer<typeof FoldOptionsSchema>;

// Defer — the literal schedule of `.defer(when)`, checked at build; the
// function form is checked when it runs. Exactly one of `after` / `at`; a
// duration's fields add up (`{ hours: 1, minutes: 30 }` is 90 minutes).
const DeferWhenSchema = z
  .object({
    after: z
      .object({
        days: z.number().positive().optional(),
        hours: z.number().positive().optional(),
        minutes: z.number().positive().optional(),
      })
      .strict()
      .refine((d) => d.days != null || d.hours != null || d.minutes != null, {
        message:
          "defer: a duration needs at least one of days, hours, or minutes",
      })
      .optional(),
    at: z.date().optional(),
  })
  .strict()
  .refine((w) => (w.after === undefined) !== (w.at === undefined), {
    message: "defer: specify exactly one of `after` or `at`",
  });

// Autoclose policy — `.autocloses({...})`. Top-level fields AND together; an
// `or` block is the alternative path, with the same fields minus `or`.
// `.strict()` turns a typo into a build error. Windows are in days: `after`
// is at least a minute and `keep` at least a day, since anything shorter is
// a misconfiguration.
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

const AfterSchema = window_schema("after", 1 / 1440, "one minute");

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

const AutoclosePolicySchema = z
  .object({
    after: AfterSchema.optional(),
    is: IsSchema.optional(),
    reaches: ReachesSchema.optional(),
    or: OrBlockSchema.optional(),
    keep: window_schema("keep", 1, "one day").optional(),
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
  ) satisfies z.ZodType<AutoclosePolicy>;

// Store — `store(adapter)` and `ActOptions.scoped.store`. A store written for
// `commit(stream, msgs, meta, expectedVersion)`, the shape before 2.0, would
// forward its arguments and treat the appends as a stream name, sending
// events and their sensitive fields wherever that name goes.
const StoreSchema = z.object({
  commit: z.custom<(...args: never[]) => unknown>(
    (commit) => typeof commit === "function" && commit.length !== 4,
    {
      message:
        "This store's commit takes (stream, msgs, meta, expectedVersion), the shape before @rotorsoft/act 2.0. Upgrade it, and every @rotorsoft/act-* package, together: https://rotorsoft.github.io/act-root/docs/guides/migrating-to-2.x",
    }
  ),
});

const SCHEMAS = {
  act: ActOptionsSchema,
  action: ActionOptionsSchema,
  audit: AuditOptionsSchema,
  autoclose: AutocloseOptionsSchema,
  autoclose_policy: AutoclosePolicySchema,
  circuit_breaker: CircuitBreakerOptionsSchema,
  defer: DeferWhenSchema,
  drain: DrainOptionsSchema,
  fold: FoldOptionsSchema,
  lane: LaneConfigSchema,
  page: PageOptionsSchema,
  poll: PollOptionsSchema,
  reaction: ReactionOptionsSchema,
  scan: ScanOptionsSchema,
  settle: SettleOptionsSchema,
  shutdown: ShutdownOptionsSchema,
  store: StoreSchema,
  target: TargetOptionsSchema,
};

type Schemas = typeof SCHEMAS;

/** Parse an option bag with its schema. Throws `ZodError` on a bad value. */
export function check<K extends keyof Schemas>(
  kind: K,
  options: z.input<Schemas[K]>
): z.output<Schemas[K]> {
  return SCHEMAS[kind].parse(options) as z.output<Schemas[K]>;
}
