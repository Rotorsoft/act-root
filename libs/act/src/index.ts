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
// Low-level restore scan helper — adapter authors and tools (e.g.,
// the inspector) that drive a {@link Store.restore} call without an
// {@link Act} orchestrator can import it directly. Most callers want
// `app.restore(source, opts)` instead.
export { scan } from "./internal/index.js";
export * from "./ports.js";
export * from "./types/index.js";
export * from "./utils.js";
