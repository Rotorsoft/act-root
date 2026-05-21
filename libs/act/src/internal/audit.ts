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
  Logger,
  Schemas,
  State,
  Store,
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
  pageSize: 500,
};

const ALL_CATEGORIES: ReadonlySet<AuditCategory> = new Set<AuditCategory>([
  "schema",
  "close-candidate",
  "restart-candidate",
  "deprecated-load",
  "reaction-health",
  "snapshot-drift",
  "routing-health",
  "correlation-gaps",
  "clock-anomalies",
]);

/**
 * Top-level audit dispatcher. Runs the per-category generators
 * sequentially and forwards their findings. Sequential rather than
 * concurrent because the underlying store sees one connection / one
 * cursor at a time; parallelism here would just contend on the same
 * pool without speedup.
 *
 * Callers can `break` the iteration early — the underlying scan
 * loops respect `for await`'s `return()` and stop cleanly.
 */
export async function* runAudit(
  deps: AuditDeps,
  categories?: AuditCategory[],
  options: AuditOptions = {}
): AsyncIterable<AuditFinding> {
  const requested = new Set<AuditCategory>(categories ?? [...ALL_CATEGORIES]);
  if (requested.has("schema")) {
    yield* auditSchema(deps, options);
  }
  if (requested.has("deprecated-load")) {
    yield* auditDeprecatedLoad(deps, options);
  }
  // Subsequent slices add: close-candidate, restart-candidate,
  // reaction-health, snapshot-drift, routing-health, correlation-gaps,
  // clock-anomalies. Each is a self-contained async generator below.
}

/**
 * `schema` — every event in the audit window is parsed against the
 * Zod schema the registry currently declares for its name. Two
 * failure modes:
 *
 *   - `unknown_event_name` — event sits on disk but the registry has
 *     no entry. Common after a rename in the builder without an
 *     `_v<n>` migration: events committed under the old name remain.
 *   - `schema_validation_failed` — event matches a known name but
 *     fails the current Zod schema. Common after tightening a
 *     schema in-place (added a required field, narrowed a type).
 *
 * Findings carry the event id + stream so the operator can drill
 * straight to the offending row. Zod's `error` object is forwarded
 * raw for callers that want per-issue detail.
 */
async function* auditSchema(
  deps: AuditDeps,
  options: AuditOptions
): AsyncIterable<AuditFinding> {
  const buffer: AuditFinding[] = [];
  await deps.store().query<Schemas>((event) => {
    const state = deps.eventToState.get(String(event.name));
    if (!state) {
      // Skip framework-internal events (snapshots, tombstones) —
      // they're not user-declared and have no Zod schema to validate
      // against. Audit's surface is the user's events.
      const name = String(event.name);
      if (name.startsWith("__")) return;
      buffer.push({
        category: "schema",
        stream: event.stream,
        eventId: event.id,
        name,
        reason: "unknown_event_name",
      });
      return;
    }
    const schema = state.events[String(event.name)];
    if (!schema) return; // defensive — eventToState mapped it but no schema?
    const parsed = schema.safeParse(event.data);
    if (!parsed.success) {
      buffer.push({
        category: "schema",
        stream: event.stream,
        eventId: event.id,
        name: String(event.name),
        reason: "schema_validation_failed",
        zodError: parsed.error,
      });
    }
  }, options.query);
  for (const f of buffer) yield f;
}

/**
 * `deprecated-load` — workspace-wide event-name histogram from
 * `query_stats({names: true})`, classified by the framework's
 * `_v<digits>` rule. For each deprecated event whose share of the
 * total store equals or exceeds the threshold, yields a finding with
 * the top-N stream carriers (sorted by per-stream count).
 *
 * Operator action: `app.close([...])` on the top streams retires
 * the legacy event surface without touching the active streams. The
 * `topStreams` cap is hard-coded at 10 — enough to take action,
 * cheap to render.
 */
async function* auditDeprecatedLoad(
  deps: AuditDeps,
  options: AuditOptions
): AsyncIterable<AuditFinding> {
  const shareMin =
    options.thresholds?.deprecatedLoadShareMin ??
    DEFAULTS.deprecatedLoadShareMin;
  const stats = await deps
    .store()
    .query_stats<Schemas>({}, { names: true, count: true });

  // Workspace totals + per-stream breakdown per event name.
  const totals = new Map<string, number>();
  const perStream = new Map<string, Map<string, number>>();
  for (const [stream, { names }] of stats) {
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
  }

  const grand = [...totals.values()].reduce((s, n) => s + n, 0);
  if (grand === 0) return;

  // Classification reads from the *registry's* known event names,
  // not the on-disk set — the framework's `_v<n>` rule is
  // registry-driven (ACT-403). If the registry declares both
  // `Foo` and `Foo_v2` but only `Foo` events exist on disk yet,
  // `Foo` is still deprecated; the audit's job is to spot that the
  // legacy events are *still in the store* and surface the load.
  const deprecated = deprecatedEventNames(deps.knownEventNames);
  // Sort deprecated events by absolute count desc so the heaviest
  // backlog surfaces first.
  const sorted = [...deprecated]
    .map((name) => ({ name, count: totals.get(name) ?? 0 }))
    .sort((a, b) => b.count - a.count);
  for (const { name, count } of sorted) {
    if (count === 0) continue; // no on-disk load — nothing for the operator to do
    if (count / grand < shareMin) continue;
    const currentVersion = currentVersionOf(name, deps.knownEventNames);
    if (!currentVersion) continue; // safety — would be a bug in deprecatedEventNames
    const topStreams = [...(perStream.get(name)?.entries() ?? [])]
      .map(([stream, c]) => ({ stream, count: c }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    yield {
      category: "deprecated-load",
      eventName: name,
      currentVersion,
      totalCount: count,
      topStreams,
    };
  }
}
