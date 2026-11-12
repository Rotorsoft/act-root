import "./signals.js";

/**
 * @packageDocumentation
 * @module act
 * Main entry point for apps. Store rules are on `@rotorsoft/act/adapter`.
 */
// Each runtime name is listed, so a new public value is a line in review.
export { Act } from "./act.js";
export {
  ConsoleLogger,
  InMemoryCache,
  InMemoryStore,
} from "./adapters/index.js";
export { act, projection, slice, state } from "./builders/index.js";
export { config } from "./config.js";
export { CsvFile } from "./csv.js";
// Deprecated in 2.x, removed in 3.0 (RFC 2411).
export {
  ActorSchema,
  CausationEventSchema,
  CommittedMetaSchema,
  check_appends,
  concurrency_error,
  DEFAULT_LANE,
  DEFAULT_MAX_SUBSCRIBED_STREAMS,
  DEFAULT_QUERY_STREAMS_LIMIT,
  DEFAULT_SETTLE_DEBOUNCE_MS,
  dateReviver,
  default_scope,
  Environments,
  EventMetaSchema,
  ExitCodes,
  extend,
  fair_slots,
  is_literal_source,
  LogLevels,
  notification_of,
  PackageSchema,
  QuerySchema,
  resolveAutocloseConfig,
  seed_event,
  TargetSchema,
  throw_if_stale,
} from "./deprecated.js";
export {
  cache,
  dispose,
  disposeAndExit,
  log,
  port,
  store,
} from "./ports.js";
// Deprecated in 2.x, removed in 3.0: use sensitiveFields.
export { pii_fields } from "./sensitive.js";
export type * from "./types/index.js";
export {
  ConcurrencyError,
  DeferSignal,
  Errors,
  NonRetryableError,
  PreconditionError,
  REDACTED,
  SHREDDED,
  SNAP_EVENT,
  StoreError,
  StreamClosedError,
  sensitive,
  sensitiveFields,
  TOMBSTONE_EVENT,
  ValidationError,
  ZodEmpty,
} from "./types/index.js";
export { sleep, validate } from "./utils.js";
