/**
 * Default cap on concurrent open subscriptions per generator
 * instance. Sized for typical business-app dashboards (dozens to a
 * few hundred viewers); high enough not to surprise small
 * deployments, low enough not to mask a missing horizontal-scale
 * strategy on big ones.
 */
export const DEFAULT_SSE_MAX_CONNECTIONS = 500;

/**
 * Default keep-alive cadence (30 s). Sits comfortably under the
 * 60 s idle timeout most reverse proxies impose.
 */
export const DEFAULT_SSE_HEARTBEAT_MS = 30_000;

/**
 * Default cap on the per-connection undelivered-frame backlog. Sized
 * so a briefly-stalled consumer on a busy stream keeps recent history
 * without letting a permanently-wedged client pin unbounded memory.
 * At overflow the stream's pending frames give way to one `_resync`, so
 * the consumer refetches instead of missing versions silently.
 */
export const DEFAULT_SSE_MAX_PENDING_PER_CONNECTION = 256;
