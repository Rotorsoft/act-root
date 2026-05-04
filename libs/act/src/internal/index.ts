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
 * Only symbols actually consumed *outside* `internal/` are re-exported here.
 * Modules within `internal/` import each other directly by file path, and
 * tests that need bare ops (e.g., `action`, `load`) likewise import from
 * the specific source file.
 *
 * @internal
 */
export { runCloseCycle, type CloseCycleDeps } from "./close-cycle.js";
export { CorrelateCycle, type StaticTarget } from "./correlate-cycle.js";
export {
  runDrainCycle,
  type DrainCycle,
  type Handle,
  type HandleBatch,
  type HandleResult,
} from "./drain-cycle.js";
export { computeLagLeadRatio } from "./drain-ratio.js";
export { type DrainOps } from "./drain.js";
export { type EsOps } from "./event-sourcing.js";
export { LruMap, LruSet } from "./lru-map.js";
export {
  _this_,
  mergeEventRegister,
  mergeProjection,
  registerState,
} from "./merge.js";
export { buildHandle, buildHandleBatch } from "./reactions.js";
export { buildDrain, buildEs } from "./tracing.js";
