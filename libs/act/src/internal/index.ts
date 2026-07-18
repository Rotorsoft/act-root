/**
 * @module internal
 * @category Internal
 *
 * Barrel for framework-internal modules. These exports are not part of the
 * public package API and may change between minors. Anything reachable from
 * `@rotorsoft/act`'s top-level barrel (`src/index.ts`) is the public surface;
 * what lives here is implementation detail used by `Act`, the builders, and
 * the orchestrator's pipelines.
 *
 * Only symbols actually consumed *via this barrel* from outside `internal/`
 * are re-exported here. Modules within `internal/` import each other
 * directly by file path; production code in `adapters/` and tests that
 * need bare ops (e.g., `action`, `load`, `LruMap`) likewise import from
 * the specific source file.
 *
 * @internal
 */

export { type AuditDeps, audit } from "./audit.js";
export {
  type AutoclosePolicy,
  compile_autoclose_policy,
  days_after,
  days_before_now,
  policy_keep_days,
  policy_min_after_days,
} from "./autoclose-policy.js";
export {
  AUTOCLOSE_TARGET_PREFIX,
  synthesize_autoclose_reactions,
} from "./autoclose-reaction.js";
export {
  hour_in_zone,
  in_autoclose_window,
  next_window_open,
} from "./autoclose-window.js";
export type { EventLaneSet } from "./build-classify.js";
export { ALL_LANES, classify_registry } from "./build-classify.js";
export { reaction_on, register_lane } from "./builder-utils.js";
export { CircuitBreaker, type CircuitState } from "./circuit-breaker.js";
export { run_close_cycle } from "./close-cycle.js";
export { CloseSignal } from "./close-signal.js";
// Every builder-facing config bag (schemas + resolvers + defaults) lives in
// one place — see ./config.js.
export {
  type ActionConfig,
  type AutocloseConfig,
  type CircuitBreakerConfig,
  type CircuitBreakerOptions,
  DEFAULT_AUTOCLOSE_CYCLE_MINUTES,
  DEFAULT_CLOSE_BATCH_SIZE,
  DEFAULT_CLOSE_YIELD_MS,
  DEFAULT_FOLD_FLUSH_EVERY,
  DEFAULT_MAX_CACHED_STATES,
  type FoldConfig,
  type ReactionConfig,
  resolveActConfig,
  resolveActionConfig,
  resolveAutocloseConfig,
  resolveBackoffConfig,
  resolveCircuitBreakerConfig,
  resolveDrainConfig,
  resolveFoldConfig,
  resolveLaneConfig,
  resolveReactionConfig,
  resolveSettleConfig,
} from "./config.js";
export { CorrelateCycle } from "./correlate-cycle.js";
export { close_correlation, default_correlator } from "./correlator.js";
export { DeferSignal } from "./defer-signal.js";
export type { DrainOps } from "./drain.js";
export {
  DrainController,
  type Handle,
  type HandleBatch,
} from "./drain-cycle.js";
export type { EsOps, PatchFn } from "./event-sourcing.js";
export { bare_patch, scan, validating_patch } from "./event-sourcing.js";
export {
  current_version_of,
  deprecated_event_names,
} from "./event-versions.js";
export {
  _this_,
  merge_event_register,
  merge_projection,
  register_state,
} from "./merge.js";
export { make_fold_handler } from "./projection-fold.js";
export { build_handle, build_handle_batch } from "./reactions.js";
export {
  _registry,
  pii_fields,
  pii_gate,
  pii_split,
  pii_strip,
  REDACTED,
  SHREDDED,
} from "./sensitive.js";
export { SettleLoop } from "./settle.js";
export { build_drain, build_es, trace_cycle } from "./tracing.js";
