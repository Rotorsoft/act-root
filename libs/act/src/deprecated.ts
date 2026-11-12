// 2.x names kept as aliases of their replacements (RFC 2411). 3.0 removes
// this file and its block in index.ts.
import type { ZodType } from "zod";
import {
  checkAppends,
  checkVersion,
  concurrencyError,
  fairSlots,
  isStreamName,
  parseNotification,
  seedEvent,
} from "./adapter.js";
import { package_schema } from "./config.js";
import { resolveAutocloseConfig as resolve_autoclose } from "./internal/config.js";
import { unscoped_ports } from "./ports.js";
import {
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
import { validate } from "./utils.js";

/** @deprecated Use `checkAppends` from `@rotorsoft/act/adapter`. */
export const check_appends: typeof checkAppends = checkAppends;
/** @deprecated Use `checkVersion` from `@rotorsoft/act/adapter`. */
export const throw_if_stale: typeof checkVersion = checkVersion;
/** @deprecated Use `concurrencyError` from `@rotorsoft/act/adapter`. */
export const concurrency_error: typeof concurrencyError = concurrencyError;
/** @deprecated Use `seedEvent` from `@rotorsoft/act/adapter`. */
export const seed_event: typeof seedEvent = seedEvent;
/** @deprecated Use `fairSlots` from `@rotorsoft/act/adapter`. */
export const fair_slots: typeof fairSlots = fairSlots;
/** @deprecated Use `isStreamName` from `@rotorsoft/act/adapter`. */
export const is_literal_source: typeof isStreamName = isStreamName;
/** @deprecated Use `parseNotification` from `@rotorsoft/act/adapter`. */
export const notification_of: typeof parseNotification = parseNotification;

/** @deprecated Import it from `@rotorsoft/act/types`. */
export const DEFAULT_QUERY_STREAMS_LIMIT: typeof default_query_streams_limit =
  default_query_streams_limit;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const ActorSchema: typeof actor_schema = actor_schema;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const TargetSchema: typeof target_schema = target_schema;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const EventMetaSchema: typeof event_meta_schema = event_meta_schema;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const CausationEventSchema: typeof causation_event_schema =
  causation_event_schema;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const CommittedMetaSchema: typeof committed_meta_schema =
  committed_meta_schema;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const QuerySchema: typeof query_schema = query_schema;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const Environments: typeof environments = environments;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const LogLevels: typeof log_levels = log_levels;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const ExitCodes: typeof exit_codes = exit_codes;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const DEFAULT_LANE: typeof default_lane = default_lane;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const DEFAULT_MAX_SUBSCRIBED_STREAMS: typeof default_max_subscribed_streams =
  default_max_subscribed_streams;
/** @deprecated Import it from `@rotorsoft/act/types`. */
export const DEFAULT_SETTLE_DEBOUNCE_MS: typeof default_settle_debounce_ms =
  default_settle_debounce_ms;

/** @deprecated No replacement: `config()` validates package.json itself. */
export const PackageSchema: typeof package_schema = package_schema;
/** @deprecated No replacement: call `store()`, `cache()` or `log()`. */
export const default_scope: typeof unscoped_ports = unscoped_ports;
/** @deprecated No replacement: `act().build()` validates these options. */
export const resolveAutocloseConfig: typeof resolve_autoclose =
  resolve_autoclose;
/** @deprecated No replacement: parse with the schema, spread the defaults. */
export const extend = <
  S extends Record<string, unknown>,
  T extends Record<string, unknown>,
>(
  source: Readonly<S>,
  schema: ZodType<S>,
  target?: Readonly<T>
): Readonly<S & T> =>
  ({ ...target, ...validate("config", source, schema) }) as Readonly<S & T>;

// An ISO-8601 timestamp, the shape `JSON.stringify` gives a `Date`.
const ISO_8601 =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[1-2][0-9]|3[0-1])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(\.\d+)?(Z|[+-][0-2][0-9]:[0-5][0-9])?$/;

/** @deprecated No replacement: events revive their own `z.date()` fields. */
export const dateReviver = (_key: string, value: unknown): unknown =>
  typeof value === "string" && ISO_8601.test(value) ? new Date(value) : value;
