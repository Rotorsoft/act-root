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

export type { EventLaneSet } from "./build-classify.js";
export { ALL_LANES, classifyRegistry } from "./build-classify.js";
export { runCloseCycle } from "./close-cycle.js";
export { CorrelateCycle } from "./correlate-cycle.js";
export { closeCorrelation, defaultCorrelator } from "./correlator.js";
export type { DrainOps } from "./drain.js";
export {
  DrainController,
  type Handle,
  type HandleBatch,
} from "./drain-cycle.js";
export type { BoundAction, EsOps } from "./event-sourcing.js";
export {
  currentVersionOf,
  deprecatedEventNames,
} from "./event-versions.js";
export {
  _this_,
  mergeEventRegister,
  mergeProjection,
  registerState,
} from "./merge.js";
export { buildHandle, buildHandleBatch } from "./reactions.js";
export { SettleLoop } from "./settle.js";
export { buildDrain, buildEs, traceCycle } from "./tracing.js";
