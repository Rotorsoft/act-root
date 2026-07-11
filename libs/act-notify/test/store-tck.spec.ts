import { PostgresStore } from "@rotorsoft/act-pg";
import { runStoreTck } from "@rotorsoft/act-tck";
import { LoopbackBroker, withBroker } from "../src/index.js";

/**
 * The acceptance bar from the audit: the decorator must be a perfect
 * Store citizen — every durability, lease-semantics, and query contract
 * of the wrapped adapter must hold through the proxy. Runs the full TCK
 * against withBroker over a real PostgresStore (docker :5431), with the
 * base's native notify channel disabled: the broker carries the wakeups.
 */
// One broker shared by every factory() instance — the real topology:
// N workers, one wakeup channel. Origins differ per instance, so the
// self-filtering cases still hold.
const broker = new LoopbackBroker();

runStoreTck({
  name: "withBroker(PostgresStore)",
  factory: () =>
    withBroker(
      new PostgresStore({
        port: 5431,
        schema: "tck_notify",
        table: "tck_notify_store",
        notify: false,
      }),
      broker
    ),
  capabilities: {
    notify: true,
    restore: true,
    pii_isolation: true,
    concurrent_claim: true,
    source_matches: true,
    pattern_claim_source: true,
  },
});
