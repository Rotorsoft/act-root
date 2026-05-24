/**
 * Adapter-pluggable discovery dispatcher (ACT-1122).
 *
 * The router's `discover` tRPC procedure forwards to `runDiscovery`,
 * which branches on the input's `kind` discriminator. Adding a new
 * adapter (MySQL, Redis, etc.) is a matter of writing a new probe
 * module and a new arm in this switch — the router stays thin.
 */
import {
  discoverPg,
  PG_PORT_RANGE_END,
  PG_PORT_RANGE_START,
} from "./pg-probe.js";
import { discoverSqlite } from "./sqlite-probe.js";
import type { DiscoveredStore, DiscoveryInput } from "./types.js";

export * from "./types.js";
export { PG_PORT_RANGE_END, PG_PORT_RANGE_START };

/**
 * Dispatch to the right probe based on the input's `kind`.
 *
 * Probes are responsible for swallowing per-file / per-port failures
 * and returning the partial result they could collect. `runDiscovery`
 * itself only re-throws unexpected dispatch failures, which the tRPC
 * layer wraps as "Discovery failed: …".
 */
export async function runDiscovery(
  input: DiscoveryInput
): Promise<DiscoveredStore[]> {
  if (input.kind === "pg") {
    return discoverPg(input);
  }
  return discoverSqlite(input);
}
