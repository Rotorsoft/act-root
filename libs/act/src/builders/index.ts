/**
 * @module builders
 * @category Builders
 *
 * Public-facing fluent builders for composing event-sourced applications:
 * `state` (aggregates), `slice` (vertical-slice modules), `projection`
 * (read-model updaters), and `act` (the orchestrator builder).
 */
export * from "./act-builder.js";
export * from "./projection-builder.js";
export * from "./slice-builder.js";
export * from "./state-builder.js";
