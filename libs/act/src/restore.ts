/**
 * Per-row source validator for the restore primitive (ACT-1125).
 * Pure source-side operation — no adapter, no I/O, no store
 * reference. Callers iterate their source and invoke the validator
 * on each row before deciding whether to invoke `Store.restore`.
 *
 * The framework provides the blocker rules; callers drive the
 * iteration:
 *
 * ```typescript
 * import { validateRestoreRow } from "@rotorsoft/act";
 *
 * const validator = validateRestoreRow();
 * const errors: Array<{ row: number; reason: string }> = [];
 * let rowIdx = 0;
 * for await (const row of parseCsv(csv)) {
 *   rowIdx++;
 *   for (const r of validator(row, rowIdx))
 *     errors.push({ row: rowIdx, reason: r.reason });
 * }
 * if (errors.length) throw new Error(`${errors.length} blockers`);
 * await store.restore!(parseCsv(csv), {});
 * ```
 *
 * Dry-run as a `Store.restore` mode was deliberately removed —
 * validating a CSV is a source operation, not a store operation.
 * Adapters own only the destructive live-write path.
 */
import { SNAP_EVENT } from "./ports.js";
import type { EventMeta } from "./types/action.js";
import type {
  RestoreOptions,
  RestoreResult,
  RestoreRow,
} from "./types/ports.js";

/**
 * Per-row validator. Returns the blockers for that row (empty array
 * if OK). Validators are typically stateful (tracking seen ids,
 * per-stream version progression) — build a fresh one per source
 * scan via {@link validateRestoreRow}.
 */
export type RestoreValidator = (
  row: RestoreRow,
  rowIdx: number
) => ReadonlyArray<{ reason: string }>;

/**
 * Adapter-provided write hook. Called by {@link runRestore} once per
 * non-dropped row, with the causation-rewritten `meta` already
 * applied. Returns the new id the adapter assigned to the row — the
 * loop adds it to the `old → new` map so subsequent rows' causation
 * refs resolve correctly.
 */
export type RestoreRowWriter = (
  row: RestoreRow,
  meta: EventMeta
) => Promise<number>;

/**
 * Drive the restore iteration loop. The framework owns iteration,
 * `drop_snapshots` filtering, `on_progress` callbacks, causation
 * remap, and kept/dropped counting. The adapter owns only the
 * transaction setup/wipe/commit around the call and the `writeRow`
 * hook that performs the actual insert.
 *
 * Returns the partial {@link RestoreResult} (without `duration_ms`)
 * — the caller wraps with its own timing because the duration
 * should cover transaction setup and commit, not just the
 * iteration window.
 *
 * ```typescript
 * const started = Date.now();
 * await openTx();
 * await wipeAll();
 * try {
 *   const partial = await runRestore(source, opts, async (row, meta) => {
 *     const newId = await insert(row, meta);
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
export async function runRestore(
  source: AsyncIterable<RestoreRow>,
  opts: RestoreOptions,
  writeRow: RestoreRowWriter
): Promise<Omit<RestoreResult, "duration_ms">> {
  const { drop_snapshots = false, on_progress } = opts;
  const idMap = new Map<number, number>();
  let kept = 0;
  let droppedSnapshots = 0;
  let rowIdx = 0;
  for await (const row of source) {
    rowIdx++;
    if (on_progress) on_progress({ processed: rowIdx });
    if (drop_snapshots && row.name === SNAP_EVENT) {
      droppedSnapshots++;
      continue;
    }
    // Causation remap — rewrite `meta.causation.event.id` to the new
    // id space if the source pointed at an earlier row's old id.
    let meta = row.meta;
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
    const newId = await writeRow(row, meta);
    idMap.set(row.id, newId);
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

/**
 * Build the default {@link RestoreValidator} closure.
 *
 * Returns a fresh stateful validator each call — the closure owns
 * its own `seenIds` set and per-stream version-progression map.
 * Categories detected:
 *
 * - **Duplicate `id`** — the renumber-on-restore contract (#783)
 *   requires unique source ids to build a coherent `old → new`
 *   causation remap. A duplicate would silently shadow one of the
 *   rows in the remap table.
 * - **Per-stream version-contiguity gap** — versions must be
 *   `0, 1, 2, …` within a stream. Gaps don't break restore itself
 *   but break downstream consumers (snapshots, projections, replay).
 * - **Malformed `created`** — `new Date(row.created)` must produce
 *   a valid timestamp.
 * - **Negative `version`** — versions are unsigned in the framework
 *   contract.
 *
 * Causation refs pointing at ids not in the source are **not**
 * blockers — they pass through unchanged per #783's contract
 * (partial backups are a supported use case).
 *
 * @example Custom validator that extends the default
 * ```typescript
 * const baseline = validateRestoreRow();
 * const myValidator: RestoreValidator = (row, rowIdx) => {
 *   const errors = [...baseline(row, rowIdx)];
 *   if (row.stream.length > 100)
 *     errors.push({ reason: "Stream name too long" });
 *   return errors;
 * };
 * ```
 */
export function validateRestoreRow(): RestoreValidator {
  const seenIds = new Set<number>();
  const expectedVersionByStream = new Map<string, number>();
  return (row, _rowIdx) => {
    const errors: Array<{ reason: string }> = [];
    if (seenIds.has(row.id)) errors.push({ reason: `Duplicate id: ${row.id}` });
    else seenIds.add(row.id);
    if (row.version < 0)
      errors.push({ reason: `Negative version: ${row.version}` });
    const created =
      row.created instanceof Date ? row.created : new Date(row.created);
    if (Number.isNaN(created.getTime()))
      errors.push({ reason: `Malformed created: ${String(row.created)}` });
    const expected = expectedVersionByStream.get(row.stream) ?? 0;
    if (row.version !== expected)
      errors.push({
        reason: `Version gap on ${row.stream}: expected ${expected}, got ${row.version}`,
      });
    expectedVersionByStream.set(row.stream, row.version + 1);
    return errors;
  };
}
