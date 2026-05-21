/**
 * @module act/types/audit
 *
 * Operator-driven store audit (#723).
 *
 * The `app.audit(...)` method walks the connected store and yields
 * per-category findings — each tagged with the remediation it
 * suggests. Same operator-driven category as `app.close()`,
 * `app.reset()`, `app.unblock()`: never auto-invoked by the
 * framework; the operator decides when to run it and what to do
 * with the findings.
 *
 * Categories are independent — operators can request a subset
 * (`app.audit(["schema", "deprecated-load"])`) or run everything by
 * omitting the category list.
 *
 * Findings are yielded as an `AsyncIterable` so callers can break
 * out early, pipe into Slack alerts, save to disk, etc. without
 * loading the entire report in memory.
 */

/**
 * Audit category names. Each maps to a distinct family of findings
 * and a distinct remediation. See {@link AuditFinding} for the
 * shapes each category emits.
 */
export type AuditCategory =
  | "schema"
  | "close-candidate"
  | "restart-candidate"
  | "deprecated-load"
  | "reaction-health"
  | "snapshot-drift"
  | "routing-health"
  | "correlation-gaps"
  | "clock-anomalies";

/**
 * Tunable thresholds for categories whose findings depend on a
 * cutoff. Sensible defaults are documented per field; operators
 * can override per call.
 */
export type AuditThresholds = {
  /** `close-candidate` (idle): days since head event committed. Default 90. */
  idleDays?: number;
  /** `restart-candidate`: minimum event count to consider close-with-restart. Default 10_000. */
  eventCountForRestart?: number;
  /** `reaction-health` (stuck-backoff): minutes since lease started. Default 30. */
  backoffStuckMinutes?: number;
  /** `deprecated-load`: minimum fraction-of-total to surface. Default 0.10. */
  deprecatedLoadShareMin?: number;
  /** `snapshot-drift`: minimum events since last snapshot to flag. Default 500. */
  snapshotDriftMin?: number;
  /** `close-candidate` (terminal): event names the operator considers terminal. */
  terminalEvents?: string[];
};

/**
 * Audit options. Most categories run unconditionally over the
 * store; `query` narrows the scan window (e.g., "only audit events
 * committed since yesterday" for an incremental cron).
 */
export type AuditOptions = {
  /**
   * Query filter applied to event-table scans. Mirrors
   * {@link Query} (stream / source / created_before / created_after /
   * before / etc.). When omitted, the audit scans the whole table.
   */
  query?: import("./action.js").Query;
  /** Pagination size for event scans. Default 500. */
  pageSize?: number;
  /** Per-category thresholds; see {@link AuditThresholds}. */
  thresholds?: AuditThresholds;
};

/**
 * Discriminated union of audit findings. Each shape carries enough
 * context for the operator to act on the finding directly —
 * stream name, event id, suggested remediation hints.
 */
export type AuditFinding =
  | {
      category: "schema";
      stream: string;
      eventId: number;
      name: string;
      reason: "unknown_event_name" | "schema_validation_failed";
      zodError?: unknown;
    }
  | {
      category: "close-candidate";
      stream: string;
      lastEventAt: string;
      reason: "terminal" | "idle";
      idleDays?: number;
      /** True when the state has a snapshot patch (`close({restart: true})` would work). */
      restartSupported: boolean;
    }
  | {
      category: "restart-candidate";
      stream: string;
      eventCount: number;
      snapshotCount: number;
    }
  | {
      category: "deprecated-load";
      eventName: string;
      currentVersion: string;
      totalCount: number;
      topStreams: Array<{ stream: string; count: number }>;
    }
  | {
      category: "reaction-health";
      stream: string;
      status: "blocked" | "near-block" | "stuck-backoff";
      retry: number;
      reason: string;
    }
  | {
      category: "snapshot-drift";
      stream: string;
      eventsSinceLastSnapshot: number;
      snapshotAt?: number;
    }
  | {
      category: "routing-health";
      stream: string;
      reason: "unknown-lane" | "unrouted";
      lane?: string;
    }
  | {
      category: "correlation-gaps";
      stream: string;
      eventId: number;
      reason: "orphan-parent" | "missing-correlation";
    }
  | {
      category: "clock-anomalies";
      stream: string;
      eventId: number;
      reason: "future-created" | "out-of-order";
    };
