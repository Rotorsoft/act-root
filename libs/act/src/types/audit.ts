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
  idle_days?: number;
  /** `restart-candidate`: minimum event count to consider close-with-restart. Default 10_000. */
  restart_min?: number;
  /** `reaction-health` (stuck-backoff): minutes since lease started. Default 30. */
  stuck_minutes?: number;
  /** `reaction-health` (near-block): retry count at which a stream is "about to block." Default 3. */
  near_block?: number;
  /** `deprecated-load`: minimum fraction-of-total to surface. Default 0.10. */
  deprecated_min?: number;
  /** `snapshot-drift`: minimum events since last snapshot to flag. Default 500. */
  drift_min?: number;
  /** `close-candidate` (terminal): event names the operator considers terminal. */
  terminal_events?: string[];
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
  page_size?: number;
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
      event_id: number;
      name: string;
      reason: "unknown_event_name" | "schema_validation_failed";
      zod_error?: unknown;
    }
  | {
      category: "close-candidate";
      stream: string;
      last_event_at: string;
      reason: "terminal" | "idle";
      idle_days?: number;
      /** True when the state has a snapshot patch (`close({restart: true})` would work). */
      restart_supported: boolean;
    }
  | {
      category: "restart-candidate";
      stream: string;
      count: number;
      snaps: number;
    }
  | {
      category: "deprecated-load";
      name: string;
      current_version: string;
      total: number;
      top_streams: Array<{ stream: string; count: number }>;
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
      events_since_snap: number;
      snap_at?: number;
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
      event_id: number;
      reason: "orphan-parent" | "missing-correlation";
    }
  | {
      category: "clock-anomalies";
      stream: string;
      event_id: number;
      reason: "future-created" | "out-of-order";
    };
