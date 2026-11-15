import { z } from "zod";
import {
  DEFAULT_SSE_HEARTBEAT_MS,
  DEFAULT_SSE_MAX_CONNECTIONS,
  DEFAULT_SSE_MAX_PENDING_PER_CONNECTION,
} from "./sse-wiring.js";

// The numeric knobs on `SseOptions`, parsed once when `hono(...)` or
// `trpc(...)` builds, so a bad value throws then, not at the first connection.
export const SseOptionsSchema = z.object({
  maxConnections: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(DEFAULT_SSE_MAX_CONNECTIONS),
  heartbeatMs: z
    .number()
    .int()
    .min(15_000)
    .max(300_000)
    .default(DEFAULT_SSE_HEARTBEAT_MS),
  maxPendingPerConnection: z
    .number()
    .int()
    .min(1)
    .max(100_000)
    .default(DEFAULT_SSE_MAX_PENDING_PER_CONNECTION),
});
