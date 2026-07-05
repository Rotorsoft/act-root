/**
 * @module act-otel
 * @category Adapters
 *
 * Prometheus bridge for Act's observability seam. The framework's stance
 * is that observability is not a core feature: lifecycle events plus the
 * Logger port are the seam, and specialized tooling plugs in. This
 * package is that plug — `instrument(app)` subscribes to the lifecycle
 * events and maintains the canonical metric set from the observability
 * guide on a prom-client registry you own.
 *
 * Metrics only, deliberately: log shipping is the pino adapter's job
 * (`@rotorsoft/act-pino` + an OpenTelemetry transport), and spans/trace
 * propagation are out of scope.
 */
import type {
  BlockedLease,
  CloseResult,
  Disposer,
  Lease,
  Schemas,
  Snapshot,
} from "@rotorsoft/act";
import { Counter, Gauge, type Registry, register } from "prom-client";
import { z } from "zod";

/**
 * The slice of a built Act the bridge needs — kept structural (same
 * pattern as the `@rotorsoft/act-http` transports) so the package does
 * not couple to the orchestrator's generics.
 */
type ActSurface = {
  on(event: never, listener: never): unknown;
  off(event: never, listener: never): unknown;
  blocked_streams(options?: {
    limit?: number;
  }): Promise<ReadonlyArray<unknown>>;
};

/**
 * Options for {@link instrument}.
 *
 * @property registry - prom-client registry to register on. Defaults to
 * prom-client's global registry, so `register.metrics()` serves the
 * bridge's metrics with everything else you export.
 * @property prefix - Metric name prefix. Default `act_`.
 * @property blockedStreamsLimit - Cap on the `blocked_streams()` read
 * behind the blocked-streams gauge (evaluated per scrape). Default 1000;
 * a fleet with more than 1000 blocked streams has bigger problems than
 * an exact gauge.
 */
export type InstrumentOptions = {
  readonly registry?: Registry;
  readonly prefix?: string;
  readonly blockedStreamsLimit?: number;
};

export const DEFAULT_METRIC_PREFIX = "act_";
export const DEFAULT_BLOCKED_STREAMS_LIMIT = 1000;

const InstrumentOptionsSchema = z.object({
  registry: z
    .custom<Registry>(
      (v) =>
        !!v &&
        typeof (v as { registerMetric?: unknown }).registerMetric ===
          "function",
      { message: "registry must be a prom-client Registry" }
    )
    .optional(),
  prefix: z
    .string()
    .regex(/^[a-zA-Z_:][a-zA-Z0-9_:]*$/, {
      message:
        "prefix must be Prometheus-legal: [a-zA-Z_:][a-zA-Z0-9_:]* (dots are not — use underscores)",
    })
    .default(DEFAULT_METRIC_PREFIX),
  blockedStreamsLimit: z
    .number()
    .int()
    .min(1)
    .default(DEFAULT_BLOCKED_STREAMS_LIMIT),
});

type InstrumentConfig = z.infer<typeof InstrumentOptionsSchema>;

function resolveInstrumentConfig(options: InstrumentOptions): InstrumentConfig {
  return InstrumentOptionsSchema.parse(options);
}

/**
 * Subscribe to a built Act's lifecycle events and maintain the canonical
 * Prometheus metric set:
 *
 * | Metric | Type | Labels | Source event |
 * |---|---|---|---|
 * | `act_events_committed_total` | counter | `name` | `committed` |
 * | `act_reactions_acked_total` | counter | `lane` | `acked` |
 * | `act_reactions_blocked_total` | counter | `lane` | `blocked` |
 * | `act_settled_total` | counter | — | `settled` |
 * | `act_streams_closed_total` | counter | — | `closed` |
 * | `act_events_forgotten_total` | counter | — | `forgotten` |
 * | `act_notifications_total` | counter | — | `notified` |
 * | `act_errors_total` | counter | `circuit` | `error` |
 * | `act_streams_blocked` | gauge | — | `blocked_streams()` per scrape |
 *
 * Label cardinality is bounded by design: event names come from the
 * registry, lanes are declared at build, circuit states are three. There
 * is deliberately no per-stream label — stream ids are unbounded and
 * would blow up a Prometheus instance.
 *
 * The alerting split from the observability guide applies: a non-zero
 * `act_streams_blocked` and `act_errors_total{circuit="open"}` growth are
 * page-worthy; the rest are dashboard material.
 *
 * Returns a {@link Disposer} that unsubscribes the listeners and removes
 * the metrics from the registry — hand it to Act's `dispose(...)` registry
 * so Ctrl-C tears the bridge down with everything else:
 *
 * @example
 * ```typescript
 * import { act, dispose } from "@rotorsoft/act";
 * import { instrument } from "@rotorsoft/act-otel";
 * import { register } from "prom-client";
 *
 * const app = act().withState(Task).build();
 * dispose(instrument(app));
 *
 * // serve the scrape endpoint on your HTTP surface
 * root.get("/metrics", async (c) => c.text(await register.metrics()));
 * ```
 *
 * @param app - A built Act orchestrator
 * @param options - See {@link InstrumentOptions}
 * @returns Disposer that detaches listeners and unregisters the metrics
 * @throws ZodError when options are out of range (misconfiguration
 * surfaces at startup, not on the first scrape)
 */
export function instrument(
  app: ActSurface,
  options: InstrumentOptions = {}
): Disposer {
  const config = resolveInstrumentConfig(options);
  const registry = config.registry ?? register;
  const p = config.prefix;
  const registers = [registry];

  const committed = new Counter({
    name: `${p}events_committed_total`,
    help: "Events committed, by event name",
    labelNames: ["name"],
    registers,
  });
  const acked = new Counter({
    name: `${p}reactions_acked_total`,
    help: "Reaction stream acks, by lane",
    labelNames: ["lane"],
    registers,
  });
  const blocked = new Counter({
    name: `${p}reactions_blocked_total`,
    help: "Reaction streams blocked by poison messages, by lane",
    labelNames: ["lane"],
    registers,
  });
  const settled = new Counter({
    name: `${p}settled_total`,
    help: "Settle cycles reaching quiescence",
    registers,
  });
  const closed = new Counter({
    name: `${p}streams_closed_total`,
    help: "Streams closed (tombstoned/truncated)",
    registers,
  });
  const forgotten = new Counter({
    name: `${p}events_forgotten_total`,
    help: "Events whose PII was erased via forget",
    registers,
  });
  const notified = new Counter({
    name: `${p}notifications_total`,
    help: "Cross-process commit notifications received",
    registers,
  });
  const errors = new Counter({
    name: `${p}errors_total`,
    help: "Store/drain errors surfaced to the circuit breaker, by circuit state",
    labelNames: ["circuit"],
    registers,
  });
  const blocked_gauge = new Gauge({
    name: `${p}streams_blocked`,
    help: "Streams currently blocked (evaluated per scrape; page on > 0)",
    registers,
    async collect() {
      const streams = await app.blocked_streams({
        limit: config.blockedStreamsLimit,
      });
      this.set(streams.length);
    },
  });

  // One named handler per lifecycle event so off() detaches exactly what
  // on() attached. Payload types come from the peer's public surface.
  const on_committed = (snapshots: Snapshot<Schemas, Schemas>[]) => {
    for (const s of snapshots)
      committed.inc({ name: (s.event as { name: string }).name });
  };
  const on_acked = (leases: Lease[]) => {
    for (const l of leases) acked.inc({ lane: l.lane ?? "default" });
  };
  const on_blocked = (leases: BlockedLease[]) => {
    for (const l of leases) blocked.inc({ lane: l.lane ?? "default" });
  };
  const on_settled = () => settled.inc();
  const on_closed = (result: CloseResult) => closed.inc(result.truncated.size);
  const on_forgotten = (result: { eventCount: number }) =>
    forgotten.inc(result.eventCount);
  const on_notified = () => notified.inc();
  const on_error = (payload: { circuit: string }) =>
    errors.inc({ circuit: payload.circuit });

  const listeners = [
    ["committed", on_committed],
    ["acked", on_acked],
    ["blocked", on_blocked],
    ["settled", on_settled],
    ["closed", on_closed],
    ["forgotten", on_forgotten],
    ["notified", on_notified],
    ["error", on_error],
  ] as const;
  for (const [event, listener] of listeners)
    app.on(event as never, listener as never);

  const metrics = [
    committed,
    acked,
    blocked,
    settled,
    closed,
    forgotten,
    notified,
    errors,
    blocked_gauge,
  ];
  return async () => {
    for (const [event, listener] of listeners)
      app.off(event as never, listener as never);
    for (const m of metrics)
      registry.removeSingleMetric((m as { name?: string }).name as string);
  };
}
