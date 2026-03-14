/**
 * @packageDocumentation
 * @module act-patch
 *
 * Immutable deep-merge patch utility for act event-sourced apps.
 * Zero dependencies, browser-safe.
 */

export { is_mergeable, patch } from "./patch.js";
export type { DeepPartial, Patch, Schema } from "./types.js";
