import "./signals.js";

/**
 * @packageDocumentation
 * @module act
 * Main entry point for the Act framework. Re-exports all core APIs.
 */
export * from "./act.js";
export * from "./adapters/index.js";
export * from "./builders/index.js";
export * from "./config.js";
export * from "./csv.js";
// The imperative defer escape hatch (#1091): a reaction throws this with a
// `DeferWhen` (see ./types/action.ts) to hold itself until the resolved
// due-time. The declarative `.defer(when)` builder step is the common path.
export { DeferSignal } from "./internal/index.js";
export * from "./ports.js";
export * from "./types/index.js";
export * from "./utils.js";
