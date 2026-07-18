/**
 * @module internal/config
 * @category Internal
 *
 * **The single home for every builder-facing config bag in act-core.** Any
 * options object an operator hands to `act().build()`, a builder method
 * (`.on(...)`, `.do(...)`, `.withLane(...)`), or a runtime cycle
 * (`drain(...)` / `settle(...)`) is validated here with Zod — never with a
 * hand-written `if (x < min) throw` ladder — so misconfiguration surfaces as
 * a `ZodError` at the entry point, not as `NaN` arithmetic on the first cycle
 * tick.
 *
 * Layout: one section per bag, each with its `DEFAULT_*` constants, an
 * internal `<Type>OptionsSchema`, an inferred `<Type>Config`, and a
 * `resolve<Type>Config(options): <Type>Config`. The schema is never
 * re-exported — the public surface is the inferred type + resolver.
 *
 * Index of bags owned here:
 * - **Backoff** — retry pacing (`BackoffOptions`), nested in reaction/action.
 * - **Reaction** — `.do(handler, options)` (`blockOnError` / `maxRetries` / `backoff`).
 * - **Action** — `.on(entry, options)` (`maxRetries` / `backoff`).
 * - **Lane** — `.withLane({...})` (`leaseMillis` / `streamLimit` / `cycleMs`).
 * - **Drain / Settle** — `drain(...)` / `settle(...)` runtime knobs.
 * - **Autoclose** — the `.autocloses` / `ActOptions` autoclose knobs (+ window).
 * - **CircuitBreaker** — the store-op breaker on `ActOptions`.
 * - **Fold** — `projection(...).of(...)` batch-fold knobs.
 *
 * Sibling env/package config (`config()`, `NODE_ENV`, log level) lives in the
 * public `../config.ts` — a different concern (process environment, not
 * builder input). The `@rotorsoft/act-http` transport bags (`SseOptions`,
 * `OpenAPIOptions`) live in that package; core cannot own another package's
 * surface.
 *
 * Validation philosophy: reject only what is genuinely broken — `NaN`,
 * `±Infinity` (Zod 4's `z.number()` rejects both by default), and negatives
 * where nonsensical. A value that works today is never newly rejected. The
 * real strictness lands on `maxRetries` and `backoff`, the knobs whose bad
 * values silently corrupt the poison-quarantine and retry-loop-exit gates.
 *
 * @internal
 */

import { z } from "zod";
import type { ActOptions } from "../act.js";
import type {
  ActionOptions,
  BackoffOptions,
  DrainOptions,
  FoldOptions,
  LaneConfig,
  ReactionOptions,
  SettleOptions,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Backoff — retry pacing. Nested inside the reaction/action bags below; also
// resolvable on its own (`resolveBackoffConfig`) for direct callers.
// ---------------------------------------------------------------------------

/**
 * Rejects an off-union `strategy`, a non-finite/negative `baseMs`, or a
 * non-finite/non-positive `maxMs` (ACT-1269). Zod 4's `z.number()` rejects
 * `NaN`/`±Infinity` by default, so `.min(0)` / `.gt(0)` also close the
 * non-finite gap. No `maxMs >= baseMs` constraint — a sub-`baseMs` cap on
 * `exponential` is documented behavior, not an error.
 * @internal
 */
const BackoffOptionsSchema = z.object({
  strategy: z.enum(["fixed", "linear", "exponential"]),
  baseMs: z.number().min(0),
  maxMs: z.number().gt(0).optional(),
  jitter: z.boolean().optional(),
});

/** Validate a backoff bag, or pass `undefined` through. Throws `ZodError`. */
export function resolveBackoffConfig(
  options: BackoffOptions | undefined
): BackoffOptions | undefined {
  return options === undefined
    ? undefined
    : BackoffOptionsSchema.parse(options);
}

// ---------------------------------------------------------------------------
// Reaction — `.do(handler, options)`. `maxRetries` gates the poison-quarantine
// decision (`retry >= maxRetries`), so a `NaN` here silently disables
// `blockOnError` (a poison message retries forever). Validate the whole bag.
// ---------------------------------------------------------------------------

const ReactionOptionsSchema = z.object({
  blockOnError: z.boolean(),
  maxRetries: z.number().int().min(0),
  backoff: BackoffOptionsSchema.optional(),
});

/** Resolved reaction options. */
export type ReactionConfig = z.infer<typeof ReactionOptionsSchema>;

/** Validate a fully-defaulted reaction options bag. Throws `ZodError`. */
export function resolveReactionConfig(
  options: ReactionOptions
): ReactionConfig {
  return ReactionOptionsSchema.parse(options);
}

// ---------------------------------------------------------------------------
// Action — `.on(entry, options)`. `maxRetries` gates the command retry loop's
// exit (`attempt >= maxRetries`), so a `NaN` here can spin the loop forever on
// a contended stream. All fields optional (the argument itself is optional).
// ---------------------------------------------------------------------------

const ActionOptionsSchema = z.object({
  maxRetries: z.number().int().min(0).optional(),
  backoff: BackoffOptionsSchema.optional(),
});

/** Resolved action options. */
export type ActionConfig = z.infer<typeof ActionOptionsSchema>;

/** Validate an action options bag. Throws `ZodError`. */
export function resolveActionConfig(options: ActionOptions): ActionConfig {
  return ActionOptionsSchema.parse(options);
}

// ---------------------------------------------------------------------------
// Lane — `.withLane({...})`. Per-lane overrides of the drain budget. Time
// knobs (`leaseMillis` / `cycleMs`) accept any non-negative ms; `streamLimit`
// is an integer count. Reject NaN/Infinity/negative; allow 0 (as today).
// ---------------------------------------------------------------------------

const LaneConfigSchema = z.object({
  name: z.string().min(1),
  leaseMillis: z.number().min(0).optional(),
  streamLimit: z.number().int().min(0).optional(),
  cycleMs: z.number().min(0).optional(),
});

/** Validate a lane config. Throws `ZodError`. Returns the input shape. */
export function resolveLaneConfig<TName extends string>(
  options: LaneConfig<TName>
): LaneConfig<TName> {
  LaneConfigSchema.parse(options);
  return options;
}

// ---------------------------------------------------------------------------
// Drain / Settle — runtime knobs for `drain(...)` / `settle(...)`. Parsed once
// per call (cheap). Reject NaN/Infinity/negative; allow 0. `correlate` is a
// pass-through query filter (validated by the store), so it is not reshaped.
// ---------------------------------------------------------------------------

const DrainOptionsSchema = z.object({
  streamLimit: z.number().int().min(0).optional(),
  eventLimit: z.number().int().min(0).optional(),
  leaseMillis: z.number().min(0).optional(),
});

/** Validate drain options, or pass `undefined` through. Throws `ZodError`. */
export function resolveDrainConfig(
  options: DrainOptions | undefined
): DrainOptions | undefined {
  if (options === undefined) return undefined;
  DrainOptionsSchema.parse(options);
  return options;
}

const SettleOptionsSchema = DrainOptionsSchema.extend({
  debounceMs: z.number().min(0).optional(),
  // `maxPasses` defaults to Infinity (no cap) when omitted; a present value is
  // a non-negative integer — `0` is legal and means "run no passes".
  maxPasses: z.number().int().min(0).optional(),
}).loose();

/** Validate settle options, or pass `undefined` through. Throws `ZodError`. */
export function resolveSettleConfig(
  options: SettleOptions | undefined
): SettleOptions | undefined {
  if (options === undefined) return undefined;
  SettleOptionsSchema.parse(options);
  return options;
}

// ---------------------------------------------------------------------------
// Act — the top-level `act().build(options)` scalar knobs. The nested bags
// (`autocloseWindow`, `circuitBreaker`) are resolved by their own resolvers
// below; the `scoped`/`correlator` fields are objects/functions passed
// through untouched (`.loose()`), so only the scalar knobs are checked here.
// ---------------------------------------------------------------------------

const ActOptionsSchema = z
  .object({
    maxSubscribedStreams: z.number().int().min(1).optional(),
    settleDebounceMs: z.number().int().min(0).optional(),
  })
  .loose();

/** Validate the scalar `ActOptions` knobs at build. Throws `ZodError`. */
export function resolveActConfig(
  options: ActOptions | undefined
): ActOptions | undefined {
  if (options === undefined) return undefined;
  ActOptionsSchema.parse(options);
  return options;
}

// ---------------------------------------------------------------------------
// Autoclose — the autoclose knobs on `ActOptions` (+ the off-hours window).
// The window *logic* (DST, hour math) stays in `autoclose-window.ts`; only
// the schema, defaults, and resolver live here.
// ---------------------------------------------------------------------------

/**
 * @deprecated The cadence knob is derived from `autocloseWindow` now (#1175);
 * nothing consumes it. Kept for compat; removed in the next major.
 */
export const DEFAULT_AUTOCLOSE_CYCLE_MINUTES = 720;
/** @deprecated Dead since #1090 removed the autoclose sweep. */
export const DEFAULT_CLOSE_BATCH_SIZE = 64;
/** @deprecated Dead since #1090 removed the autoclose sweep. */
export const DEFAULT_CLOSE_YIELD_MS = 0;
/** Default IANA zone for `autocloseWindow` when the operator omits one. */
export const DEFAULT_AUTOCLOSE_WINDOW_TZ = "UTC";

/** True when `tz` is a zone the runtime's `Intl` accepts. @internal */
function is_valid_time_zone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const AutocloseWindowSchema = z
  .object({
    start: z
      .number()
      .int()
      .min(0)
      .max(23, { message: "autocloseWindow.start must be an hour in [0, 23]" }),
    end: z
      .number()
      .int()
      .min(0)
      .max(23, { message: "autocloseWindow.end must be an hour in [0, 23]" }),
    timeZone: z
      .string()
      .refine(is_valid_time_zone, {
        message: "autocloseWindow.timeZone must be a valid IANA time zone",
      })
      .default(DEFAULT_AUTOCLOSE_WINDOW_TZ),
  })
  .refine((w) => w.start !== w.end, {
    message:
      "autocloseWindow.start and end must differ — an empty window disables autoclose",
  });

const AutocloseOptionsSchema = z.object({
  autocloseCycleMinutes: z
    .number()
    .int()
    .min(1)
    .max(1440)
    .default(DEFAULT_AUTOCLOSE_CYCLE_MINUTES),
  closeBatchSize: z
    .number()
    .int()
    .min(1)
    .max(1024)
    .default(DEFAULT_CLOSE_BATCH_SIZE),
  closeYieldMs: z.number().min(0).max(1000).default(DEFAULT_CLOSE_YIELD_MS),
  closeOnError: z.boolean().default(false),
  autocloseWindow: AutocloseWindowSchema.optional(),
});

/** Resolved autoclose configuration after validation + default expansion. */
export type AutocloseConfig = z.infer<typeof AutocloseOptionsSchema>;

/** Validate + default the autoclose knobs on `ActOptions`. Throws `ZodError`. */
export function resolveAutocloseConfig(
  options: ActOptions | undefined
): AutocloseConfig {
  return AutocloseOptionsSchema.parse({
    autocloseCycleMinutes: options?.autocloseCycleMinutes,
    closeBatchSize: options?.closeBatchSize,
    closeYieldMs: options?.closeYieldMs,
    closeOnError: options?.closeOnError,
    autocloseWindow: options?.autocloseWindow,
  });
}

// ---------------------------------------------------------------------------
// CircuitBreaker — the store-op breaker on `ActOptions`. The `CircuitBreaker`
// state machine stays in `circuit-breaker.ts` and imports the resolved type.
// ---------------------------------------------------------------------------

export const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 5;
export const DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000;

const CircuitBreakerOptionsSchema = z.object({
  failureThreshold: z
    .number()
    .int()
    .min(1)
    .default(DEFAULT_CIRCUIT_FAILURE_THRESHOLD),
  cooldownMs: z
    .number()
    .int()
    .min(100)
    .max(3_600_000)
    .default(DEFAULT_CIRCUIT_COOLDOWN_MS),
});

/** Public, all-optional circuit-breaker options bag for `act().build()`. */
export type CircuitBreakerOptions = z.input<typeof CircuitBreakerOptionsSchema>;

/** Resolved circuit-breaker configuration. */
export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerOptionsSchema>;

/** Parse + apply defaults. Throws `ZodError` on out-of-range values. */
export const resolveCircuitBreakerConfig = (
  options?: CircuitBreakerOptions
): CircuitBreakerConfig => CircuitBreakerOptionsSchema.parse(options ?? {});

// ---------------------------------------------------------------------------
// Fold — `projection(name).of(state)` batch-fold knobs.
// ---------------------------------------------------------------------------

export const DEFAULT_FOLD_FLUSH_EVERY = 1_000;
export const DEFAULT_MAX_CACHED_STATES = 10_000;

const FoldOptionsSchema = z.object({
  flushEvery: z.number().int().min(1).default(DEFAULT_FOLD_FLUSH_EVERY),
  maxCachedStates: z.number().int().min(1).default(DEFAULT_MAX_CACHED_STATES),
});

/** Resolved fold configuration. */
export type FoldConfig = z.infer<typeof FoldOptionsSchema>;

/** Validate + default the fold knobs. Throws `ZodError`. */
export function resolveFoldConfig(options: FoldOptions): FoldConfig {
  return FoldOptionsSchema.parse(options);
}
