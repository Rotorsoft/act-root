/**
 * Operator-driven store audit. Each category is an {@link AuditPass}; the
 * dispatcher runs each needed scan once and broadcasts rows to every pass,
 * so an audit costs at most three scans. Reads only {@link AuditDeps} and
 * the public `Store`, never orchestration internals.
 */

import { pii_fields } from "../sensitive.js";
import type {
  AuditCategory,
  AuditFinding,
  AuditOptions,
  Committed,
  Query,
  Schemas,
  State,
  Store,
  StreamPosition,
  StreamStats,
} from "../types/index.js";
import { SNAP_EVENT } from "../types/index.js";
import {
  current_version_of,
  deprecated_event_names,
} from "./event-versions.js";
import { walk_streams } from "./walk-streams.js";

/** The orchestrator state the audit reads, built once at `build()`. */
export type AuditDeps = {
  readonly store: () => Store;
  /** event-name → state that registers it (for schema validation). */
  readonly event_to_state: ReadonlyMap<string, State<any, any, any>>;
  /** Declared drain lanes (for routing-health unknown-lane). */
  readonly declared_lanes: ReadonlySet<string>;
  /** Event names with at least one reaction (routing-health `unrouted`). */
  readonly routed_events: ReadonlySet<string>;
};

/** Defaults for {@link AuditOptions.thresholds}. */
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
  "unreadable-events",
] as const satisfies readonly AuditCategory[];

/**
 * One audit category. Which `on_*` callbacks it has decides which shared
 * scans run; `finalize` does targeted follow-up reads; `drain` returns
 * the findings.
 */
type AuditPass = {
  category: AuditCategory;
  on_event?: (e: Committed<Schemas, string>) => void;
  on_unreadable?: (row: UnreadableRow) => void;
  on_stream?: (p: StreamPosition) => void;
  on_stat?: (stream: string, s: StreamStats<Schemas>) => void;
  finalize?: (deps: AuditDeps) => Promise<void>;
  drain: () => AuditFinding[];
};

type PassFactory = (deps: AuditDeps, options: AuditOptions) => AuditPass;

/** Scans finish before the first yield; bound the work with `options.query`. */
export async function* audit(
  deps: AuditDeps,
  categories?: AuditCategory[],
  options: AuditOptions = {}
): AsyncIterable<AuditFinding> {
  const requested = new Set<AuditCategory>(categories ?? [...ALL_CATEGORIES]);
  // Declaration order, not the caller's.
  const ordered_categories = ALL_CATEGORIES.filter((c) => requested.has(c));
  const passes: AuditPass[] = ordered_categories.map((c) =>
    PASS_FACTORIES[c](deps, options)
  );

  const need_stats = passes.some((p) => p.on_stat !== undefined);
  const need_streams = passes.some((p) => p.on_stream !== undefined);
  const need_events = passes.some(
    (p) => p.on_event !== undefined || p.on_unreadable !== undefined
  );

  if (need_stats) {
    // Exclude `__snapshot__` so head and count are domain figures; keep
    // `__tombstone__`, which is how a closed stream is recognized.
    const stats = await deps
      .store()
      .query_stats<Schemas>(
        {},
        { count: true, names: true, exclude: [SNAP_EVENT] }
      );
    for (const [stream, s] of stats) {
      for (const p of passes) p.on_stat?.(stream, s);
    }
  }

  if (need_streams) {
    // Paged: `query_streams` defaults to 100 rows.
    await walk_streams(deps.store(), (pos) => {
      for (const p of passes) p.on_stream?.(pos);
    });
  }

  if (need_events) {
    await scan_events_resiliently(
      deps,
      options.query,
      (event) => {
        for (const p of passes) p.on_event?.(event);
      },
      (row) => {
        for (const p of passes) p.on_unreadable?.(row);
      }
    );
  }

  // Serial to avoid pool contention.
  for (const p of passes) await p.finalize?.(deps);

  for (const p of passes) {
    for (const f of p.drain()) yield f;
  }
}

/**
 * A row the store couldn't hand back, located by re-reading it without its
 * payload (`with_pii: false`), which can't fail.
 */
type UnreadableRow = {
  stream: string;
  event_id: number;
  error: unknown;
};

/**
 * Run the event scan so one unreadable row doesn't end it: locate the row
 * it stopped at, report it, and resume past it with the remaining `limit`.
 * Backward scans can't resume, so they rethrow.
 */
async function scan_events_resiliently(
  deps: AuditDeps,
  query: Query | undefined,
  on_event: (e: Committed<Schemas, string>) => void,
  on_unreadable: (row: UnreadableRow) => void
): Promise<void> {
  let cursor = query?.after;
  let remaining = query?.limit;
  for (;;) {
    let seen = 0;
    try {
      await deps.store().query<Schemas>(
        (event) => {
          seen++;
          cursor = event.id;
          on_event(event);
        },
        {
          ...query,
          after: cursor,
          ...(remaining !== undefined && { limit: remaining }),
        }
      );
      return;
    } catch (error) {
      if (query?.backward) throw error;
      let row: UnreadableRow | undefined;
      await deps.store().query<Schemas>(
        (e) => {
          row = { stream: e.stream, event_id: e.id, error };
        },
        { ...query, after: cursor, limit: 1, with_pii: false }
      );
      // Not one unreadable row (a dropped connection, a timeout): rethrow.
      if (!row) throw error;
      on_unreadable(row);
      // The tripping row is never delivered, so `seen` is at most
      // `remaining - 1` and the resumed budget stays at 1 or more.
      if (remaining !== undefined) remaining -= seen;
      cursor = row.event_id;
    }
  }
}

// =================== Pass factories ===================

const make_schema_pass: PassFactory = (deps) => {
  const findings: AuditFinding[] = [];
  return {
    category: "schema",
    on_event(event) {
      const name = String(event.name);
      const state = deps.event_to_state.get(name);
      if (!state) {
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
      // `sensitive()` keys live in the pii sidecar, so omit them from the parse.
      const sensitive = pii_fields(schema);
      let parse_schema = schema;
      if (sensitive.length > 0) {
        const omitter = (
          schema as unknown as {
            omit?: (mask: Record<string, true>) => typeof schema;
          }
        ).omit;
        if (typeof omitter !== "function") {
          // A non-object schema with pii can't be masked; any parse is a false positive.
          return;
        }
        parse_schema = omitter.call(
          schema,
          Object.fromEntries(sensitive.map((f) => [f, true as const]))
        );
      }
      const parsed = parse_schema.safeParse(event.data);
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

/** Deprecated event name → its current sibling, within one state only. */
const classify_deprecated_by_state = (
  deps: AuditDeps
): ReadonlyMap<string, string> => {
  const names_by_state = new Map<State<any, any, any>, Set<string>>();
  for (const [name, state] of deps.event_to_state) {
    let set = names_by_state.get(state);
    if (!set) {
      set = new Set();
      names_by_state.set(state, set);
    }
    set.add(name);
  }
  const deprecated_to_current = new Map<string, string>();
  for (const names of names_by_state.values()) {
    for (const name of deprecated_event_names(names)) {
      deprecated_to_current.set(name, current_version_of(name, names)!);
    }
  }
  return deprecated_to_current;
};

const make_deprecated_load_pass: PassFactory = (deps, options) => {
  const share_min =
    options.thresholds?.deprecated_min ?? DEFAULTS.deprecated_min;
  const totals = new Map<string, number>();
  const per_stream = new Map<string, Map<string, number>>();
  return {
    category: "deprecated-load",
    on_stat(stream, { names }) {
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
      const deprecated = classify_deprecated_by_state(deps);
      const sorted = [...deprecated.keys()]
        .map((name) => ({ name, count: totals.get(name) ?? 0 }))
        .sort((a, b) => b.count - a.count);
      for (const { name, count } of sorted) {
        if (count === 0) continue;
        if (count / grand < share_min) continue;
        const current_version = deprecated.get(name)!;
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

const make_restart_candidate_pass: PassFactory = (deps, options) => {
  const threshold = options.thresholds?.restart_min ?? DEFAULTS.restart_min;
  // Snapshot counts are resolved in finalize: the shared stat scan excludes
  // `__snapshot__`, and only a handful of candidates need them.
  const candidates: Array<{ stream: string; count: number }> = [];
  const findings: AuditFinding[] = [];
  return {
    category: "restart-candidate",
    on_stat(stream, { head, count }) {
      if (count! < threshold) return;
      const head_name = String(head.name);
      if (head_name.startsWith("__")) return;
      if (!restart_is_supported(deps, head_name)) return;
      candidates.push({ stream, count: count! });
    },
    async finalize(deps) {
      for (const { stream, count } of candidates) {
        let snaps = 0;
        await deps.store().query(
          () => {
            snaps++;
          },
          {
            stream,
            stream_exact: true,
            names: [SNAP_EVENT],
            with_snaps: true,
          }
        );
        findings.push({
          category: "restart-candidate",
          stream,
          count,
          snaps,
        });
      }
    },
    drain: () => findings,
  };
};

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

const make_snapshot_drift_pass: PassFactory = (deps, options) => {
  const drift_min = options.thresholds?.drift_min ?? DEFAULTS.drift_min;
  const candidates: Array<{
    stream: string;
    total: number;
  }> = [];
  const findings: AuditFinding[] = [];
  return {
    category: "snapshot-drift",
    on_stat(stream, { head, count }) {
      // Also rejects framework markers, which no user state declares.
      if (!restart_is_supported(deps, String(head.name))) return;
      if (count! < drift_min) return; // upper-bound short-circuit
      candidates.push({
        stream,
        total: count!,
      });
    },
    async finalize(deps) {
      for (const { stream, total } of candidates) {
        let events_since_snap = total;
        let snap_at: number | undefined;
        // The shared stat scan excludes `__snapshot__`, so look it up here.
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
        if (collected.length > 0) {
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

const make_clock_anomalies_pass: PassFactory = () => {
  const findings: AuditFinding[] = [];
  const last_per_stream = new Map<string, number>();
  return {
    category: "clock-anomalies",
    on_event(e) {
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

function restart_is_supported(
  deps: AuditDeps,
  head_event_name: string
): boolean {
  const state = deps.event_to_state.get(head_event_name);
  return state?.snap !== undefined;
}

/** Fed by the dispatcher with rows the event scan tripped on; never reaches `on_event`. */
function make_unreadable_events_pass(): AuditPass {
  const findings: AuditFinding[] = [];
  return {
    category: "unreadable-events",
    on_unreadable({ stream, event_id, error }) {
      findings.push({
        category: "unreadable-events",
        stream,
        event_id,
        reason: "pii_decrypt_failed",
        error,
      });
    },
    drain: () => findings,
  };
}

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
  "unreadable-events": make_unreadable_events_pass,
};
