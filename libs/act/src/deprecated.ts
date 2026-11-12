/**
 * Names the root still exports for 2.x callers, each pointing at its
 * replacement ([RFC 2411](https://github.com/Rotorsoft/act-root/blob/master/rfcs/2411-adapter-subpath.md)).
 * All of them are removed in 3.0, together with this file and their lines in
 * `index.ts`; `pii_fields` is the one alias kept next to its replacement, in
 * `sensitive.ts`, because `/types` publishes it too.
 */
import {
  checkAppends,
  checkVersion,
  concurrencyError,
  fairSlots,
  isStreamName,
  parseNotification,
  seedEvent,
} from "./adapter.js";
import { PackageSchema as package_schema } from "./config.js";
import { resolveAutocloseConfig as resolve_autoclose } from "./internal/config.js";
import { default_scope as unscoped_ports } from "./ports.js";
import {
  type ActOptions,
  type AutocloseConfig,
  ActorSchema as actor_schema,
  CausationEventSchema as causation_event_schema,
  CommittedMetaSchema as committed_meta_schema,
  DEFAULT_LANE as default_lane,
  DEFAULT_MAX_SUBSCRIBED_STREAMS as default_max_subscribed_streams,
  DEFAULT_QUERY_STREAMS_LIMIT as default_query_streams_limit,
  DEFAULT_SETTLE_DEBOUNCE_MS as default_settle_debounce_ms,
  Environments as environments,
  EventMetaSchema as event_meta_schema,
  ExitCodes as exit_codes,
  LogLevels as log_levels,
  QuerySchema as query_schema,
  TargetSchema as target_schema,
} from "./types/index.js";
import { extend as extend_config } from "./utils.js";

/** @deprecated Use `checkAppends` from `@rotorsoft/act/adapter`. */
export const check_appends = checkAppends;
/** @deprecated Use `checkVersion` from `@rotorsoft/act/adapter`. */
export const throw_if_stale = checkVersion;
/** @deprecated Use `concurrencyError` from `@rotorsoft/act/adapter`. */
export const concurrency_error = concurrencyError;
/** @deprecated Use `seedEvent` from `@rotorsoft/act/adapter`. */
export const seed_event = seedEvent;
/** @deprecated Use `fairSlots` from `@rotorsoft/act/adapter`. */
export const fair_slots = fairSlots;
/** @deprecated Use `isStreamName` from `@rotorsoft/act/adapter`. */
export const is_literal_source = isStreamName;
/** @deprecated Use `parseNotification` from `@rotorsoft/act/adapter`. */
export const notification_of = parseNotification;

/** @deprecated Import it from `@rotorsoft/act/types`. */
export const DEFAULT_QUERY_STREAMS_LIMIT = default_query_streams_limit;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const ActorSchema = actor_schema;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const TargetSchema = target_schema;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const EventMetaSchema = event_meta_schema;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const CausationEventSchema = causation_event_schema;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const CommittedMetaSchema = committed_meta_schema;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const QuerySchema = query_schema;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const Environments = environments;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const LogLevels = log_levels;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const ExitCodes = exit_codes;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const DEFAULT_LANE = default_lane;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const DEFAULT_MAX_SUBSCRIBED_STREAMS = default_max_subscribed_streams;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const DEFAULT_SETTLE_DEBOUNCE_MS = default_settle_debounce_ms;

/**
 * @deprecated Removed in 3.0 with no replacement: `config()` validates
 * package.json itself.
 */
export const PackageSchema = package_schema;
/**
 * @deprecated Removed in 3.0 with no replacement: `store()`, `cache()` and
 * `log()` called outside a scoped handler give the same adapters.
 */
export const default_scope = unscoped_ports;
/**
 * @deprecated Removed in 3.0 with no replacement: `act().build()` validates
 * the autoclose options.
 */
export function resolveAutocloseConfig(
  options: ActOptions | undefined
): AutocloseConfig {
  return resolve_autoclose(options);
}
/**
 * @deprecated Removed in 3.0 with no replacement: parse into a Zod schema and
 * spread over the defaults.
 */
export const extend = extend_config;

/**
 * Matches an ISO-8601 timestamp, the shape `JSON.stringify` produces for a
 * `Date`.
 */
const ISO_8601 =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[1-2][0-9]|3[0-1])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(\.\d+)?(Z|[+-][0-2][0-9]:[0-5][0-9])?$/;

/**
 * Revive ISO-8601-shaped strings into `Date`s during `JSON.parse`. It turns
 * every timestamp-shaped string into a `Date`, including fields declared as
 * `z.string()`.
 *
 * @deprecated Removed in 3.0 with no replacement: the framework converts only
 * the fields an event's schema declares as `z.date()`, and a host can write
 * the same reviver in a few lines.
 */
export const dateReviver = (_key: string, value: unknown): unknown =>
  typeof value === "string" && ISO_8601.test(value) ? new Date(value) : value;
