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
import type { RestoreRow } from "./types/ports.js";

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
