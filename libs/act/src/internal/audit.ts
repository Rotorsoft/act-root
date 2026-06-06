/**
 * @module audit
 * @category Internal
 *
 * Operator-driven store audit (#723).
 *
 * Walks the connected store and yields per-category {@link AuditFinding}s.
 * Each category answers a different "what should I do with this store?"
 * question and pairs with a remediation:
 *
 *   - `schema` → fix the data model (poison events, unknown names)
 *   - `close-candidate` → `app.close([...])`
 *   - `restart-candidate` → `app.close([{stream, restart:true}, …])`
 *   - `deprecated-load` → `app.close([...])` on the heaviest carriers
 *   - `reaction-health` → `app.unblock(...)` / `app.reset(...)`
 *   - `snapshot-drift` → manual `load({snap:true})` or wait for policy
 *   - `routing-health` → restart-with-new-config to re-lane
 *   - `correlation-gaps` → fix upstream correlator misconfig
 *   - `clock-anomalies` → infra remediation (clock skew)
 *
 * ## Single-scan multiplex (efficiency contract)
 *
 * Earlier draft had each category run its own `store.query(...)`,
 * which meant N requested categories → N table walks. Bad for large
 * stores. Refactored to a pass-based design: each category is a
 * factory that returns an {@link AuditPass} with optional per-row
 * callbacks (`on_event` / `on_stream` / `on_stat`) and a `finalize` hook
 * for any second-pass work. The dispatcher determines the UNION of
 * required data sources, runs each *once*, and broadcasts each row
 * to all interested passes. Worst case: three scans total (events,
 * streams, stats) regardless of how many categories the operator
 * requested. Most categories also share state — close-candidate and
 * restart-candidate both consume the same `on_stat` stream; schema,
 * correlation-gaps, and clock-anomalies all hang off the same
 * `on_event` broadcast.
 *
 * Categories that need follow-up work (snapshot-drift's per-stream
 * snapshot lookup, correlation-gaps' orphan-id check after collecting
 * ids) do that in their `finalize` hook with their own targeted store
 * calls — keeps the shared scan path minimal.
 *
 * Isolated from orchestration internals — `act.ts` builds the
 * {@link AuditDeps} bag at `.build()` time and hands it here via
 * a one-liner. The audit module never reaches into
 * `internal/{event-sourcing,drain-cycle,settle,close-cycle}.ts`; it
 * only reads through the deps interface and the public `Store`
 * surface. Same shape as `act-tck` within the workspace — a peer of
 * orchestration, not entangled with its private mechanics.
 *
 * @internal
 */

import type {
  AuditCategory,
  AuditFinding,
  AuditOptions,
  Committed,
  Logger,
  Schemas,
  State,
  Store,
  StreamPosition,
  StreamStats,
} from "../types/index.js";
import {
  current_version_of,
  deprecated_event_names,
} from "./event-versions.js";

/**
 * Snapshot of orchestrator state the audit reads. Built once at
 * `app.build()`; the audit treats it as immutable for the duration
 * of a call. The orchestrator never passes its own private maps in
 * directly — this bag is the abstraction boundary so a future
 * orchestration refactor can't accidentally entangle with audit
 * logic.
 */
export type AuditDeps = {
  readonly store: () => Store;
  readonly logger: Logger;
  /** event-name → state that registers it (for schema validation). */
  readonly event_to_state: ReadonlyMap<string, State<any, any, any>>;
  /** state-name → state (for snapshot-supported check on restart-candidate). */
  readonly states: ReadonlyMap<string, State<any, any, any>>;
  /** All event names the registry knows (for unknown-name detection). */
  readonly known_events: ReadonlySet<string>;
  /** Declared drain lanes (for routing-health unknown-lane). */
  readonly declared_lanes: ReadonlySet<string>;
  /**
   * Event names that the registry has at least one reaction for —
   * used by routing-health to detect "registered but unrouted"
   * events. Normalized down from the internal `event_to_lanes` map
   * (which carries lane-set details audit doesn't need).
   */
  readonly routed_events: ReadonlySet<string>;
};

/**
 * Defaults applied when the operator doesn't override via
 * {@link AuditOptions.thresholds}. Values land where most workloads
 * find them operationally useful — operators can tune per call.
 */
const DEFAULTS = {
  idle_days: 90,
  restart_min: 10_000,
  stuck_minutes: 30,
  deprecated_min: 0.1,
  drift_min: 500,
  near_block: 3,
};

const ALL_CATEGORIES = [
  "schema",
  "close-candidate",
  "restart-candidate",
  "deprecated-load",
  "reaction-health",
  "snapshot-drift",
  "routing-health",
  "correlation-gaps",
  "clock-anomalies",
] as const satisfies readonly AuditCategory[];

/**
 * A single audit category, expressed as a stream-consumer:
 *
 * - `on_event` / `on_stream` / `on_stat` are called by the dispatcher
 *   during the shared scans. Each is optional; the dispatcher uses
 *   the presence/absence to decide which scans to run.
 * - `finalize` runs after all shared scans complete. Categories that
 *   need targeted follow-up store calls (snapshot-drift fetches the
 *   last `__snapshot__` per drifted stream; correlation-gaps cross-
 *   checks causations against the collected id set) do that here.
 * - `drain` is called last and returns the accumulated findings.
 */
type AuditPass = {
  category: AuditCategory;
  on_event?: (e: Committed<Schemas, string>) => void;
  on_stream?: (p: StreamPosition) => void;
  on_stat?: (stream: string, s: StreamStats<Schemas>) => void;
  finalize?: (deps: AuditDeps) => Promise<void>;
  drain: () => AuditFinding[];
};

type PassFactory = (deps: AuditDeps, options: AuditOptions) => AuditPass;

/**
 * Top-level audit dispatcher. Single-scan multiplex: each requested
 * category contributes a `AuditPass`, the dispatcher determines the
 * union of required data sources (events / streams / stats), runs
 * each once, broadcasts rows, and yields per-category findings in
 * the order the categories were requested.
 *
 * Callers can `break` the iteration early — the underlying scan
 * loops have already completed by the time yield starts, so early
 * break only saves the iteration over already-collected findings.
 * (Per-row early termination during a scan isn't feasible without
 * coordination across passes; the audit is bounded by `options.query`
 * scoping rather than mid-scan cancellation.)
 */
export async function* audit(
  deps: AuditDeps,
  categories?: AuditCategory[],
  options: AuditOptions = {}
): AsyncIterable<AuditFinding> {
  const requested = new Set<AuditCategory>(categories ?? [...ALL_CATEGORIES]);
  // Preserve a deterministic category order (matches ALL_CATEGORIES
  // declaration) so output ordering doesn't depend on the order
  // operators list categories in their call.
  const ordered_categories = ALL_CATEGORIES.filter((c) => requested.has(c));
  const passes: AuditPass[] = ordered_categories.map((c) =>
    PASS_FACTORIES[c](deps, options)
  );

  // Determine scan needs. `some(...)` short-circuits — three trivial
  // walks at worst.
  const need_stats = passes.some((p) => p.on_stat !== undefined);
  const need_streams = passes.some((p) => p.on_stream !== undefined);
  const need_events = passes.some((p) => p.on_event !== undefined);

  if (need_stats) {
    const stats = await deps
      .store()
      .query_stats<Schemas>({}, { count: true, names: true });
    for (const [stream, s] of stats) {
      for (const p of passes) p.on_stat?.(stream, s);
    }
  }

  if (need_streams) {
    await deps.store().query_streams((pos) => {
      for (const p of passes) p.on_stream?.(pos);
    });
  }

  if (need_events) {
    await deps.store().query<Schemas>((event) => {
      for (const p of passes) p.on_event?.(event);
    }, options.query);
  }

  // Async post-processing (per-stream queries, second-pass orphan
  // detection). Serial to avoid pool contention; categories are
  // independent so order doesn't matter semantically.
  for (const p of passes) await p.finalize?.(deps);

  // Yield findings in requested-category order.
  for (const p of passes) {
    for (const f of p.drain()) yield f;
  }
}

// =================== Pass factories ===================
//
// Each category is implemented as a closure-bound `AuditPass`. The
// factory captures `deps` + relevant options + a `findings` array;
// the returned pass exposes the per-row hooks the dispatcher calls.
//
// All findings are accumulated in a per-pass `findings` buffer and
// returned from `drain()`. No yield-during-scan — that would couple
// the pass to async iteration semantics and prevent the shared-scan
// multiplexing.

/**
 * `schema` — every event in the audit window is parsed against the
 * Zod schema the registry currently declares for its name. Two
 * failure modes: `unknown_event_name` (event sits on disk, registry
 * has no entry) and `schema_validation_failed` (event matches a
 * known name but fails the current Zod schema).
 */
const make_schema_pass: PassFactory = (deps) => {
  const findings: AuditFinding[] = [];
  return {
    category: "schema",
    on_event(event) {
      const name = String(event.name);
      const state = deps.event_to_state.get(name);
      if (!state) {
        // Skip framework markers — they're not user-declared.
        if (name.startsWith("__")) return;
        findings.push({
          category: "schema",
          stream: event.stream,
          event_id: event.id,
          name,
          reason: "unknown_event_name",
        });
        return;
      }
      const schema = state.events[name];
      const parsed = schema.safeParse(event.data);
      if (!parsed.success) {
        findings.push({
          category: "schema",
          stream: event.stream,
          event_id: event.id,
          name,
          reason: "schema_validation_failed",
          zod_error: parsed.error,
        });
      }
    },
    drain: () => findings,
  };
};

/**
 * `deprecated-load` — workspace-wide event-name histogram classified
 * by the framework's `_v<digits>` rule. Built from the shared `on_stat`
 * stream — accumulates per-name + per-stream totals in memory, then
 * emits one finding per deprecated event above the threshold during
 * `drain`.
 */
const make_deprecated_load_pass: PassFactory = (deps, options) => {
  const share_min =
    options.thresholds?.deprecated_min ?? DEFAULTS.deprecated_min;
  const totals = new Map<string, number>();
  const per_stream = new Map<string, Map<string, number>>();
  return {
    category: "deprecated-load",
    on_stat(stream, { names }) {
      // Contract: query_stats was called with `{names: true}`,
      // so adapter populates `names` with positive integer counts.
      // No runtime fallback needed.
      for (const [name, count] of Object.entries(names!)) {
        totals.set(name, (totals.get(name) ?? 0) + count!);
        let m = per_stream.get(name);
        if (!m) {
          m = new Map();
          per_stream.set(name, m);
        }
        m.set(stream, count!);
      }
    },
    drain() {
      const findings: AuditFinding[] = [];
      const grand = [...totals.values()].reduce((s, n) => s + n, 0);
      if (grand === 0) return findings;
      // Registry-driven deprecation classification (not on-disk-driven).
      const deprecated = deprecated_event_names(deps.known_events);
      const sorted = [...deprecated]
        .map((name) => ({ name, count: totals.get(name) ?? 0 }))
        .sort((a, b) => b.count - a.count);
      for (const { name, count } of sorted) {
        if (count === 0) continue;
        if (count / grand < share_min) continue;
        // Contract: `deprecated_event_names(registry)` only returns names
        // that have a higher version in the same family, so
        // `current_version_of(name, registry)` is guaranteed defined.
        const current_version = current_version_of(name, deps.known_events)!;
        // per_stream is populated in lockstep with totals — name is guaranteed present.
        const top_streams = [...per_stream.get(name)!.entries()]
          .map(([stream, c]) => ({ stream, count: c }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);
        findings.push({
          category: "deprecated-load",
          name,
          current_version,
          total: count,
          top_streams,
        });
      }
      return findings;
    },
  };
};

/**
 * `close-candidate` — flags streams ripe for `app.close(...)`. Two
 * flavours: `idle` (head older than `idle_days`) and `terminal` (head
 * event name in operator-supplied `terminal_events` list). Each
 * finding carries `restart_supported` (state has `.snap()`).
 */
const make_close_candidate_pass: PassFactory = (deps, options) => {
  const idle_days = options.thresholds?.idle_days ?? DEFAULTS.idle_days;
  const terminal_events = new Set(options.thresholds?.terminal_events ?? []);
  const idle_cutoff = Date.now() - idle_days * 24 * 60 * 60 * 1000;
  const findings: AuditFinding[] = [];
  return {
    category: "close-candidate",
    on_stat(stream, { head }) {
      const head_name = String(head.name);
      if (head_name.startsWith("__")) return; // already-closed or mid-truncate
      // All in-tree adapters return `created` as Date; the Date
      // constructor passes Date instances through unchanged, so a
      // single call shape works regardless.
      const head_time = head.created.getTime();
      const is_idle = head_time < idle_cutoff;
      const is_terminal = terminal_events.has(head_name);
      if (!is_idle && !is_terminal) return;
      findings.push({
        category: "close-candidate",
        stream,
        last_event_at: head.created.toISOString(),
        reason: is_terminal ? "terminal" : "idle",
        idle_days: is_idle
          ? Math.floor((Date.now() - head_time) / (24 * 60 * 60 * 1000))
          : undefined,
        restart_supported: restart_is_supported(deps, head_name),
      });
    },
    drain: () => findings,
  };
};

/**
 * `restart-candidate` — streams above `event_count_for_restart` whose
 * state declares `.snap()`. Reads from the shared `on_stat` stream.
 */
const make_restart_candidate_pass: PassFactory = (deps, options) => {
  const threshold = options.thresholds?.restart_min ?? DEFAULTS.restart_min;
  const findings: AuditFinding[] = [];
  return {
    category: "restart-candidate",
    on_stat(stream, { head, count, names }) {
      // `count` / `names` always populated — query_stats is called
      // with both flags set; adapters keep them present together.
      if (count! < threshold) return;
      const head_name = String(head.name);
      if (head_name.startsWith("__")) return;
      if (!restart_is_supported(deps, head_name)) return;
      findings.push({
        category: "restart-candidate",
        stream,
        count: count!,
        // names map is sparse — `__snapshot__` key absent when the
        // stream has never been snapshotted (a common case for the
        // restart-candidate signal).
        snaps: names!["__snapshot__"] ?? 0,
      });
    },
    drain: () => findings,
  };
};

/**
 * `reaction-health` — surfaces blocked / near-block / stuck-backoff
 * streams. Reads from the shared `on_stream` stream-positions
 * broadcast.
 */
const make_reaction_health_pass: PassFactory = (_deps, options) => {
  const near_block = options.thresholds?.near_block ?? DEFAULTS.near_block;
  const stuck_minutes =
    options.thresholds?.stuck_minutes ?? DEFAULTS.stuck_minutes;
  const stuck_cutoff = Date.now() - stuck_minutes * 60 * 1000;
  const findings: AuditFinding[] = [];
  return {
    category: "reaction-health",
    on_stream(p) {
      if (p.blocked) {
        findings.push({
          category: "reaction-health",
          stream: p.stream,
          status: "blocked",
          retry: p.retry,
          reason: p.error || "blocked without recorded error",
        });
        return;
      }
      if (p.retry >= near_block) {
        findings.push({
          category: "reaction-health",
          stream: p.stream,
          status: "near-block",
          retry: p.retry,
          reason: `retry ${p.retry} ≥ near-block threshold ${near_block}`,
        });
        return;
      }
      if (
        p.leased_by &&
        p.leased_until &&
        p.leased_until.getTime() < stuck_cutoff
      ) {
        const minutes = Math.floor(
          (Date.now() - p.leased_until.getTime()) / (60 * 1000)
        );
        findings.push({
          category: "reaction-health",
          stream: p.stream,
          status: "stuck-backoff",
          retry: p.retry,
          reason: `lease expired ${minutes}m ago without release`,
        });
      }
    },
    drain: () => findings,
  };
};

/**
 * `snapshot-drift` — buffers candidate streams from the shared
 * `on_stat` pass (skipping non-snap states + tombstoned heads), then
 * does targeted per-stream lookups in `finalize` to find the last
 * `__snapshot__` event id and count events past it.
 */
const make_snapshot_drift_pass: PassFactory = (deps, options) => {
  const drift_min = options.thresholds?.drift_min ?? DEFAULTS.drift_min;
  // Streams the workspace pass identifies as drift candidates —
  // resolved in finalize with per-stream queries.
  const candidates: Array<{
    stream: string;
    total: number;
    snaps: number;
  }> = [];
  const findings: AuditFinding[] = [];
  return {
    category: "snapshot-drift",
    on_stat(stream, { head, count, names }) {
      // restart_is_supported() already filters out framework markers
      // (__snapshot__, __tombstone__) — neither name appears in any
      // user state's events map, so the snap check rejects them.
      if (!restart_is_supported(deps, String(head.name))) return;
      if (count! < drift_min) return; // upper-bound short-circuit
      candidates.push({
        stream,
        total: count!,
        snaps: names!["__snapshot__"] ?? 0,
      });
    },
    async finalize(deps) {
      for (const { stream, total, snaps } of candidates) {
        let events_since_snap = total;
        let snap_at: number | undefined;
        if (snaps > 0) {
          const collected: Array<{ id: number }> = [];
          await deps.store().query(
            (e) => {
              collected.push({ id: e.id });
            },
            {
              stream,
              stream_exact: true,
              names: ["__snapshot__"],
              backward: true,
              limit: 1,
              with_snaps: true,
            }
          );
          // snaps > 0 means at least one `__snapshot__` event sits on
          // this stream — the backward-walk above must surface it.
          snap_at = collected[0]!.id;
          let after = 0;
          await deps.store().query(
            () => {
              after++;
            },
            { stream, stream_exact: true, after: snap_at }
          );
          events_since_snap = after;
        }
        if (events_since_snap < drift_min) continue;
        findings.push({
          category: "snapshot-drift",
          stream,
          events_since_snap,
          snap_at,
        });
      }
    },
    drain: () => findings,
  };
};

/**
 * `routing-health` — `unknown-lane` from the streams-table pass +
 * `unrouted` from the stats pass. Reads from BOTH shared streams.
 */
const make_routing_health_pass: PassFactory = (deps) => {
  const findings: AuditFinding[] = [];
  const seen_event_names = new Set<string>();
  return {
    category: "routing-health",
    on_stream(p) {
      if (!p.lane) return; // default lane — never an unknown-lane finding
      if (deps.declared_lanes.has(p.lane)) return;
      findings.push({
        category: "routing-health",
        stream: p.stream,
        reason: "unknown-lane",
        lane: p.lane,
      });
    },
    on_stat(_stream, { names }) {
      for (const name of Object.keys(names!)) {
        seen_event_names.add(name);
      }
    },
    finalize() {
      for (const name of seen_event_names) {
        if (name.startsWith("__")) continue;
        if (deps.routed_events.has(name)) continue;
        findings.push({
          category: "routing-health",
          stream: "*",
          reason: "unrouted",
        });
      }
      return Promise.resolve();
    },
    drain: () => findings,
  };
};

/**
 * `correlation-gaps` — collects ids + parent_ids during the shared
 * event pass; flags orphans in `drain`. No second store walk — the
 * id-set + the (id, parent) buffer are both populated in one pass.
 */
const make_correlation_gaps_pass: PassFactory = () => {
  const seen_ids = new Set<number>();
  const checks: Array<{ stream: string; id: number; parent_id: number }> = [];
  return {
    category: "correlation-gaps",
    on_event(e) {
      seen_ids.add(e.id);
      const causation = (e.meta as Record<string, unknown> | undefined)
        ?.causation as { event?: { id?: number } } | undefined;
      const parent_id = causation?.event?.id;
      if (parent_id !== undefined) {
        checks.push({ stream: e.stream, id: e.id, parent_id });
      }
    },
    drain() {
      const findings: AuditFinding[] = [];
      for (const { stream, id, parent_id } of checks) {
        if (!seen_ids.has(parent_id)) {
          findings.push({
            category: "correlation-gaps",
            stream,
            event_id: id,
            reason: "orphan-parent",
          });
        }
      }
      return findings;
    },
  };
};

/**
 * `clock-anomalies` — flags future timestamps + per-stream out-of-
 * order `created`. Single pass, per-stream "last seen" state in a
 * Map. Cheap.
 */
const make_clock_anomalies_pass: PassFactory = () => {
  const findings: AuditFinding[] = [];
  const last_per_stream = new Map<string, number>();
  return {
    category: "clock-anomalies",
    on_event(e) {
      // `created` is a Date instance per the Store contract.
      const created = e.created.getTime();
      if (created > Date.now()) {
        findings.push({
          category: "clock-anomalies",
          stream: e.stream,
          event_id: e.id,
          reason: "future-created",
        });
      }
      const prev = last_per_stream.get(e.stream);
      if (prev !== undefined && created < prev) {
        findings.push({
          category: "clock-anomalies",
          stream: e.stream,
          event_id: e.id,
          reason: "out-of-order",
        });
      }
      last_per_stream.set(e.stream, created);
    },
    drain: () => findings,
  };
};

/** Does the stream's owning state declare a `.snap()` reducer? */
function restart_is_supported(
  deps: AuditDeps,
  head_event_name: string
): boolean {
  const state = deps.event_to_state.get(head_event_name);
  return state?.snap !== undefined;
}

/** Factory registry — pass-creation indexed by category name. */
const PASS_FACTORIES: Record<AuditCategory, PassFactory> = {
  schema: make_schema_pass,
  "deprecated-load": make_deprecated_load_pass,
  "close-candidate": make_close_candidate_pass,
  "restart-candidate": make_restart_candidate_pass,
  "reaction-health": make_reaction_health_pass,
  "snapshot-drift": make_snapshot_drift_pass,
  "routing-health": make_routing_health_pass,
  "correlation-gaps": make_correlation_gaps_pass,
  "clock-anomalies": make_clock_anomalies_pass,
};
