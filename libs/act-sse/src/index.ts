/**
 * @packageDocumentation
 * @module act-sse
 *
 * **Deprecated.** This package's surface has moved to the
 * `@rotorsoft/act-http/sse` subpath of the `@rotorsoft/act-http` umbrella.
 * It now re-exports that subpath verbatim so the two cannot drift, and is
 * kept only as a migration shim — bug fixes land in `@rotorsoft/act-http`,
 * and this package is scheduled for removal in a future release. Migrate by
 * changing the import path:
 *
 * ```ts
 * - import { BroadcastChannel } from "@rotorsoft/act-sse";
 * + import { BroadcastChannel } from "@rotorsoft/act-http/sse";
 * ```
 */

export * from "@rotorsoft/act-http/sse";
