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
 * callbacks (`onEvent` / `onStream` / `onStat`) and a `finalize` hook
 * for any second-pass work. The dispatcher determines the UNION of
 * required data sources, runs each *once*, and broadcasts each row
 * to all interested passes. Worst case: three scans total (events,
 * streams, stats) regardless of how many categories the operator
 * requested. Most categories also share state — close-candidate and
 * restart-candidate both consume the same `onStat` stream; schema,
 * correlation-gaps, and clock-anomalies all hang off the same
 * `onEvent` broadcast.
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
import { currentVersionOf, deprecatedEventNames } from "./event-versions.js";

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
  readonly eventToState: ReadonlyMap<string, State<any, any, any>>;
  /** state-name → state (for snapshot-supported check on restart-candidate). */
  readonly states: ReadonlyMap<string, State<any, any, any>>;
  /** All event names the registry knows (for unknown-name detection). */
  readonly knownEventNames: ReadonlySet<string>;
  /** Declared drain lanes (for routing-health unknown-lane). */
  readonly declaredLanes: ReadonlySet<string>;
  /**
   * Event names that the registry has at least one reaction for —
   * used by routing-health to detect "registered but unrouted"
   * events. Normalized down from the internal `eventToLanes` map
   * (which carries lane-set details audit doesn't need).
   */
  readonly routedEventNames: ReadonlySet<string>;
};

/**
 * Defaults applied when the operator doesn't override via
 * {@link AuditOptions.thresholds}. Values land where most workloads
 * find them operationally useful — operators can tune per call.
 */
const DEFAULTS = {
  idleDays: 90,
  eventCountForRestart: 10_000,
  backoffStuckMinutes: 30,
  deprecatedLoadShareMin: 0.1,
  snapshotDriftMin: 500,
  nearBlockRetry: 3,
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
 * - `onEvent` / `onStream` / `onStat` are called by the dispatcher
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
  onEvent?: (e: Committed<Schemas, string>) => void;
  onStream?: (p: StreamPosition) => void;
  onStat?: (stream: string, s: StreamStats<Schemas>) => void;
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
export async function* runAudit(
  deps: AuditDeps,
  categories?: AuditCategory[],
  options: AuditOptions = {}
): AsyncIterable<AuditFinding> {
  const requested = new Set<AuditCategory>(categories ?? [...ALL_CATEGORIES]);
  // Preserve a deterministic category order (matches ALL_CATEGORIES
  // declaration) so output ordering doesn't depend on the order
  // operators list categories in their call.
  const orderedCategories = ALL_CATEGORIES.filter((c) => requested.has(c));
  const passes: AuditPass[] = orderedCategories.map((c) =>
    PASS_FACTORIES[c](deps, options)
  );

  // Determine scan needs. `some(...)` short-circuits — three trivial
  // walks at worst.
  const needStats = passes.some((p) => p.onStat !== undefined);
  const needStreams = passes.some((p) => p.onStream !== undefined);
  const needEvents = passes.some((p) => p.onEvent !== undefined);

  if (needStats) {
    const stats = await deps
      .store()
      .query_stats<Schemas>({}, { count: true, names: true });
    for (const [stream, s] of stats) {
      for (const p of passes) p.onStat?.(stream, s);
    }
  }

  if (needStreams) {
    await deps.store().query_streams((pos) => {
      for (const p of passes) p.onStream?.(pos);
    });
  }

  if (needEvents) {
    await deps.store().query<Schemas>((event) => {
      for (const p of passes) p.onEvent?.(event);
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
const makeSchemaPass: PassFactory = (deps) => {
  const findings: AuditFinding[] = [];
  return {
    category: "schema",
    onEvent(event) {
      const name = String(event.name);
      const state = deps.eventToState.get(name);
      if (!state) {
        // Skip framework markers — they're not user-declared.
        if (name.startsWith("__")) return;
        findings.push({
          category: "schema",
          stream: event.stream,
          eventId: event.id,
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
          eventId: event.id,
          name,
          reason: "schema_validation_failed",
          zodError: parsed.error,
        });
      }
    },
    drain: () => findings,
  };
};

/**
 * `deprecated-load` — workspace-wide event-name histogram classified
 * by the framework's `_v<digits>` rule. Built from the shared `onStat`
 * stream — accumulates per-name + per-stream totals in memory, then
 * emits one finding per deprecated event above the threshold during
 * `drain`.
 */
const makeDeprecatedLoadPass: PassFactory = (deps, options) => {
  const shareMin =
    options.thresholds?.deprecatedLoadShareMin ??
    DEFAULTS.deprecatedLoadShareMin;
  const totals = new Map<string, number>();
  const perStream = new Map<string, Map<string, number>>();
  return {
    category: "deprecated-load",
    onStat(stream, { names }) {
      for (const [name, n] of Object.entries(names ?? {})) {
        const count = n ?? 0;
        if (count === 0) continue;
        totals.set(name, (totals.get(name) ?? 0) + count);
        let m = perStream.get(name);
        if (!m) {
          m = new Map();
          perStream.set(name, m);
        }
        m.set(stream, count);
      }
    },
    drain() {
      const findings: AuditFinding[] = [];
      const grand = [...totals.values()].reduce((s, n) => s + n, 0);
      if (grand === 0) return findings;
      // Registry-driven deprecation classification (not on-disk-driven).
      const deprecated = deprecatedEventNames(deps.knownEventNames);
      const sorted = [...deprecated]
        .map((name) => ({ name, count: totals.get(name) ?? 0 }))
        .sort((a, b) => b.count - a.count);
      for (const { name, count } of sorted) {
        if (count === 0) continue;
        if (count / grand < shareMin) continue;
        const currentVersion = currentVersionOf(name, deps.knownEventNames);
        if (!currentVersion) continue;
        const topStreams = [...(perStream.get(name)?.entries() ?? [])]
          .map(([stream, c]) => ({ stream, count: c }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);
        findings.push({
          category: "deprecated-load",
          eventName: name,
          currentVersion,
          totalCount: count,
          topStreams,
        });
      }
      return findings;
    },
  };
};

/**
 * `close-candidate` — flags streams ripe for `app.close(...)`. Two
 * flavours: `idle` (head older than `idleDays`) and `terminal` (head
 * event name in operator-supplied `terminalEvents` list). Each
 * finding carries `restartSupported` (state has `.snap()`).
 */
const makeCloseCandidatePass: PassFactory = (deps, options) => {
  const idleDays = options.thresholds?.idleDays ?? DEFAULTS.idleDays;
  const terminalEvents = new Set(options.thresholds?.terminalEvents ?? []);
  const idleCutoff = Date.now() - idleDays * 24 * 60 * 60 * 1000;
  const findings: AuditFinding[] = [];
  return {
    category: "close-candidate",
    onStat(stream, { head }) {
      const headName = String(head.name);
      if (headName.startsWith("__")) return; // already-closed or mid-truncate
      const headTime =
        head.created instanceof Date
          ? head.created.getTime()
          : new Date(head.created as unknown as string).getTime();
      const isIdle = Number.isFinite(headTime) && headTime < idleCutoff;
      const isTerminal = terminalEvents.has(headName);
      if (!isIdle && !isTerminal) return;
      findings.push({
        category: "close-candidate",
        stream,
        lastEventAt:
          head.created instanceof Date
            ? head.created.toISOString()
            : String(head.created),
        reason: isTerminal ? "terminal" : "idle",
        idleDays: isIdle
          ? Math.floor((Date.now() - headTime) / (24 * 60 * 60 * 1000))
          : undefined,
        restartSupported: restartIsSupported(deps, headName),
      });
    },
    drain: () => findings,
  };
};

/**
 * `restart-candidate` — streams above `eventCountForRestart` whose
 * state declares `.snap()`. Reads from the shared `onStat` stream.
 */
const makeRestartCandidatePass: PassFactory = (deps, options) => {
  const threshold =
    options.thresholds?.eventCountForRestart ?? DEFAULTS.eventCountForRestart;
  const findings: AuditFinding[] = [];
  return {
    category: "restart-candidate",
    onStat(stream, { head, count, names }) {
      const total = count ?? 0;
      if (total < threshold) return;
      const headName = String(head.name);
      if (headName.startsWith("__")) return;
      if (!restartIsSupported(deps, headName)) return;
      findings.push({
        category: "restart-candidate",
        stream,
        eventCount: total,
        snapshotCount: names?.["__snapshot__"] ?? 0,
      });
    },
    drain: () => findings,
  };
};

/**
 * `reaction-health` — surfaces blocked / near-block / stuck-backoff
 * streams. Reads from the shared `onStream` stream-positions
 * broadcast.
 */
const makeReactionHealthPass: PassFactory = (_deps, options) => {
  const nearBlockRetry =
    options.thresholds?.nearBlockRetry ?? DEFAULTS.nearBlockRetry;
  const stuckMinutes =
    options.thresholds?.backoffStuckMinutes ?? DEFAULTS.backoffStuckMinutes;
  const stuckCutoff = Date.now() - stuckMinutes * 60 * 1000;
  const findings: AuditFinding[] = [];
  return {
    category: "reaction-health",
    onStream(p) {
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
      if (p.retry >= nearBlockRetry) {
        findings.push({
          category: "reaction-health",
          stream: p.stream,
          status: "near-block",
          retry: p.retry,
          reason: `retry ${p.retry} ≥ near-block threshold ${nearBlockRetry}`,
        });
        return;
      }
      if (
        p.leased_by &&
        p.leased_until &&
        p.leased_until.getTime() < stuckCutoff
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
 * `onStat` pass (skipping non-snap states + tombstoned heads), then
 * does targeted per-stream lookups in `finalize` to find the last
 * `__snapshot__` event id and count events past it.
 */
const makeSnapshotDriftPass: PassFactory = (deps, options) => {
  const driftMin =
    options.thresholds?.snapshotDriftMin ?? DEFAULTS.snapshotDriftMin;
  // Streams the workspace pass identifies as drift candidates —
  // resolved in finalize with per-stream queries.
  const candidates: Array<{
    stream: string;
    total: number;
    snapshotCount: number;
  }> = [];
  const findings: AuditFinding[] = [];
  return {
    category: "snapshot-drift",
    onStat(stream, { head, count, names }) {
      if (!restartIsSupported(deps, String(head.name))) return;
      if (String(head.name).startsWith("__")) return;
      const total = count ?? 0;
      if (total < driftMin) return; // upper-bound short-circuit
      candidates.push({
        stream,
        total,
        snapshotCount: names?.["__snapshot__"] ?? 0,
      });
    },
    async finalize(deps) {
      for (const { stream, total, snapshotCount } of candidates) {
        let eventsSinceLastSnapshot = total;
        let snapshotAt: number | undefined;
        if (snapshotCount > 0) {
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
          snapshotAt = collected[0]?.id;
          if (snapshotAt !== undefined) {
            let after = 0;
            await deps.store().query(
              () => {
                after++;
              },
              { stream, stream_exact: true, after: snapshotAt }
            );
            eventsSinceLastSnapshot = after;
          }
        }
        if (eventsSinceLastSnapshot < driftMin) continue;
        findings.push({
          category: "snapshot-drift",
          stream,
          eventsSinceLastSnapshot,
          snapshotAt,
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
const makeRoutingHealthPass: PassFactory = (deps) => {
  const findings: AuditFinding[] = [];
  const seenEventNames = new Set<string>();
  return {
    category: "routing-health",
    onStream(p) {
      if (!p.lane) return; // default lane — never an unknown-lane finding
      if (deps.declaredLanes.has(p.lane)) return;
      findings.push({
        category: "routing-health",
        stream: p.stream,
        reason: "unknown-lane",
        lane: p.lane,
      });
    },
    onStat(_stream, { names }) {
      for (const [name, n] of Object.entries(names ?? {})) {
        if (!n || n === 0) continue;
        seenEventNames.add(name);
      }
    },
    finalize() {
      for (const name of seenEventNames) {
        if (name.startsWith("__")) continue;
        if (deps.routedEventNames.has(name)) continue;
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
const makeCorrelationGapsPass: PassFactory = () => {
  const seenIds = new Set<number>();
  const checks: Array<{ stream: string; id: number; parentId: number }> = [];
  return {
    category: "correlation-gaps",
    onEvent(e) {
      seenIds.add(e.id);
      const causation = (e.meta as Record<string, unknown> | undefined)
        ?.causation as { event?: { id?: number } } | undefined;
      const parentId = causation?.event?.id;
      if (parentId !== undefined) {
        checks.push({ stream: e.stream, id: e.id, parentId });
      }
    },
    drain() {
      const findings: AuditFinding[] = [];
      for (const { stream, id, parentId } of checks) {
        if (!seenIds.has(parentId)) {
          findings.push({
            category: "correlation-gaps",
            stream,
            eventId: id,
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
const makeClockAnomaliesPass: PassFactory = () => {
  const findings: AuditFinding[] = [];
  const lastPerStream = new Map<string, number>();
  return {
    category: "clock-anomalies",
    onEvent(e) {
      const created =
        e.created instanceof Date
          ? e.created.getTime()
          : new Date(e.created as unknown as string).getTime();
      if (!Number.isFinite(created)) return;
      if (created > Date.now()) {
        findings.push({
          category: "clock-anomalies",
          stream: e.stream,
          eventId: e.id,
          reason: "future-created",
        });
      }
      const prev = lastPerStream.get(e.stream);
      if (prev !== undefined && created < prev) {
        findings.push({
          category: "clock-anomalies",
          stream: e.stream,
          eventId: e.id,
          reason: "out-of-order",
        });
      }
      lastPerStream.set(e.stream, created);
    },
    drain: () => findings,
  };
};

/** Does the stream's owning state declare a `.snap()` reducer? */
function restartIsSupported(deps: AuditDeps, headEventName: string): boolean {
  const state = deps.eventToState.get(headEventName);
  return state?.snap !== undefined;
}

/** Factory registry — pass-creation indexed by category name. */
const PASS_FACTORIES: Record<AuditCategory, PassFactory> = {
  schema: makeSchemaPass,
  "deprecated-load": makeDeprecatedLoadPass,
  "close-candidate": makeCloseCandidatePass,
  "restart-candidate": makeRestartCandidatePass,
  "reaction-health": makeReactionHealthPass,
  "snapshot-drift": makeSnapshotDriftPass,
  "routing-health": makeRoutingHealthPass,
  "correlation-gaps": makeCorrelationGapsPass,
  "clock-anomalies": makeClockAnomaliesPass,
};
