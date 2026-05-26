/**
 * Source-side scan helper for the restore primitive (ACT-1125).
 * Pure — no adapter, no I/O, no store reference. Drives iteration,
 * validates each event inline, applies `drop_snapshots`, fires
 * `on_progress`, and rewrites causation refs to the new id space.
 *
 * Two call modes — same loop, same validation:
 *
 * **Pre-flight (no committer)** — callers pass no `commit`. `scan`
 * walks the source, validates every event, and throws on the first
 * blocker. A clean return means the source is restorable.
 *
 * ```typescript
 * import { scan } from "@rotorsoft/act";
 *
 * await scan(parseCsv(csv));            // throws on bad event
 * await store.restore!(parseCsv(csv));  // safe to commit
 * ```
 *
 * **Restore (committer provided)** — adapters call `scan` from inside
 * their transaction, passing a `commit` callback. Each non-dropped
 * event is validated, committed, and the returned new id recorded for
 * causation remap on later events.
 *
 * Dry-run as a `Store.restore` mode was deliberately removed —
 * validating a CSV is a source operation, not a store operation.
 * Adapters own only the destructive live-write path.
 */
import { SNAP_EVENT } from "./ports.js";
import type { EventMeta } from "./types/action.js";
import type {
  RestoreEvent,
  RestoreOptions,
  RestoreResult,
} from "./types/ports.js";

/**
 * Per-event blocker check. Categories:
 *
 * - **Negative `version`** — versions are unsigned in the framework
 *   contract.
 * - **Malformed `created`** — `new Date(event.created)` must produce
 *   a valid timestamp. CSV / JSONL sources stream `created` as a
 *   string; garbage strings get caught here.
 *
 * Cross-event invariants (duplicate ids, per-stream version gaps) are
 * **not** the validator's job — DB `UNIQUE(stream, version)` catches
 * duplicates at commit time, and gap detection is a caller-specific
 * policy (partial backups intentionally have gaps).
 */
function isValid(event: RestoreEvent): boolean {
  if (event.version < 0) return false;
  const created =
    event.created instanceof Date ? event.created : new Date(event.created);
  if (Number.isNaN(created.getTime())) return false;
  return true;
}

/**
 * Adapter-provided commit hook. Called by {@link scan} once per
 * non-dropped event, with the causation-rewritten `meta` already
 * applied. Returns the new id the adapter assigned to the event —
 * the loop adds it to the `old → new` map so subsequent events'
 * causation refs resolve correctly.
 */
export type RestoreCommit = (
  event: RestoreEvent,
  meta: EventMeta
) => Promise<number>;

/**
 * Scan a restore source event by event. The framework owns iteration,
 * validation, the `drop_snapshots` filter, the `on_progress` callback,
 * and the causation remap. Adapters supply only `commit`.
 *
 * Throws on the first invalid event (negative version, malformed
 * `created`) with the running index in the message.
 *
 * When called without `commit`, `scan` runs as a pre-flight: it
 * validates the source but writes nothing. A clean return means the
 * source is restorable.
 *
 * Returns the partial {@link RestoreResult} (without `duration_ms`)
 * — adapters wrap with their own timing because the duration should
 * cover transaction setup and commit, not just the iteration window.
 *
 * ```typescript
 * const started = Date.now();
 * await openTx();
 * await wipeAll();
 * try {
 *   const partial = await scan(source, opts, async (event, meta) => {
 *     const newId = await insert(event, meta);
 *     return newId;
 *   });
 *   await commit();
 *   return { ...partial, duration_ms: Date.now() - started };
 * } catch (err) {
 *   await rollback();
 *   throw err;
 * }
 * ```
 */
export async function scan(
  source: AsyncIterable<RestoreEvent>,
  opts: RestoreOptions = {},
  commit?: RestoreCommit
): Promise<Omit<RestoreResult, "duration_ms">> {
  const { drop_snapshots = false, on_progress } = opts;
  const idMap = new Map<number, number>();
  let kept = 0;
  let droppedSnapshots = 0;
  let processed = 0;
  for await (const event of source) {
    processed++;
    if (!isValid(event)) throw new Error(`Invalid event at index ${processed}`);
    if (on_progress) on_progress({ processed });
    if (drop_snapshots && event.name === SNAP_EVENT) {
      droppedSnapshots++;
      continue;
    }
    if (!commit) {
      kept++;
      continue;
    }
    // Causation remap — rewrite `meta.causation.event.id` to the new
    // id space if the source pointed at an earlier event's old id.
    let meta = event.meta;
    const causedBy = meta.causation.event?.id;
    if (causedBy !== undefined) {
      const remapped = idMap.get(causedBy);
      if (remapped !== undefined && remapped !== causedBy) {
        meta = {
          ...meta,
          causation: {
            ...meta.causation,
            event: { ...meta.causation.event!, id: remapped },
          },
        };
      }
    }
    const newId = await commit(event, meta);
    idMap.set(event.id, newId);
    kept++;
  }
  return {
    kept,
    dropped: {
      closed_streams: 0,
      snapshots: droppedSnapshots,
      empty_streams: 0,
    },
  };
}
