/**
 * Per-row blocker check used by {@link Store.restore} dry-run mode
 * (ACT-1125). Single source of truth for the dry-run contract — every
 * adapter (`InMemoryStore`, `PostgresStore`, `SqliteStore`, plus any
 * future third-party adapter that opts into the `restore` capability)
 * calls this function so the set of "what counts as a blocker" stays
 * consistent across the in-tree implementations.
 *
 * Categories:
 *
 * - **Duplicate `id` in source** — the renumber-on-restore contract
 *   (#783) requires unique source ids to build a coherent
 *   `old → new` causation remap. A duplicate would silently shadow
 *   one of the rows in the remap table.
 * - **Per-stream version-contiguity gap** — versions must be `0, 1,
 *   2, …` within a stream. Gaps don't break restore itself but break
 *   downstream consumers (snapshots, projections that step through
 *   versions, replay consistency).
 * - **Malformed `created`** — `new Date(row.created)` must produce a
 *   valid timestamp. Restore preserves `created` verbatim and a
 *   `NaN` `getTime()` flows through to the rebuilt store as
 *   `Invalid Date`.
 * - **Negative `version`** — versions are unsigned in the framework
 *   contract; a negative value is a malformed source.
 *
 * Causation refs pointing at ids not in the source are **not**
 * blockers — they pass through unchanged per #783's contract
 * (partial backups are a supported use case).
 *
 * Adapters call this once per row in `dry_run` mode and never in
 * live mode (live restore is atomic per #783; first error throws
 * and rolls back). External callers can also use this directly to
 * pre-validate a backup before invoking `restore` — the function is
 * stateless aside from the three Map/Set/Array references the
 * caller carries between calls.
 *
 * @example Pre-validate a CSV before restore
 * ```typescript
 * import { validateRestoreRow } from "@rotorsoft/act";
 *
 * const seenIds = new Set<number>();
 * const expectedVersionByStream = new Map<string, number>();
 * const errors: Array<{ row: number; reason: string }> = [];
 * let rowIdx = 0;
 * for await (const row of parseCsv(csv)) {
 *   rowIdx++;
 *   validateRestoreRow(row, rowIdx, seenIds, expectedVersionByStream, errors);
 * }
 * if (errors.length) throw new Error(`Backup has ${errors.length} blockers`);
 * ```
 */
import type { RestoreRow } from "./types/ports.js";

export function validateRestoreRow(
  row: RestoreRow,
  rowIdx: number,
  seenIds: Set<number>,
  expectedVersionByStream: Map<string, number>,
  errors: Array<{ row: number; reason: string }>
): void {
  if (seenIds.has(row.id))
    errors.push({ row: rowIdx, reason: `Duplicate id: ${row.id}` });
  else seenIds.add(row.id);
  if (row.version < 0)
    errors.push({
      row: rowIdx,
      reason: `Negative version: ${row.version}`,
    });
  const created =
    row.created instanceof Date ? row.created : new Date(row.created);
  if (Number.isNaN(created.getTime()))
    errors.push({
      row: rowIdx,
      reason: `Malformed created: ${String(row.created)}`,
    });
  const expected = expectedVersionByStream.get(row.stream) ?? 0;
  if (row.version !== expected)
    errors.push({
      row: rowIdx,
      reason: `Version gap on ${row.stream}: expected ${expected}, got ${row.version}`,
    });
  // Advance past the source-provided version so subsequent rows
  // don't cascade gap errors after the first one.
  expectedVersionByStream.set(row.stream, row.version + 1);
}
