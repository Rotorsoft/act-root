/**
 * Default dry-run validator factory for {@link Store.restore}
 * (ACT-1125). Single source of truth for the blocker contract — but
 * the **adapter** doesn't import it. Adapters call whatever
 * validator the caller hands them via {@link RestoreOptions.validate}.
 * This file exports the canonical implementation so callers can
 * compose it, wrap it, or replace it without each adapter shipping
 * its own copy.
 *
 * Categories the default validator detects:
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
 *   valid timestamp.
 * - **Negative `version`** — versions are unsigned in the framework
 *   contract; a negative value is a malformed source.
 *
 * Causation refs pointing at ids not in the source are **not**
 * blockers — they pass through unchanged per #783's contract
 * (partial backups are a supported use case).
 */
import { SNAP_EVENT } from "./ports.js";
import type {
  RestoreOptions,
  RestoreResult,
  RestoreRow,
} from "./types/ports.js";

/**
 * Per-row dry-run validator. Adapters call this once per row when
 * {@link RestoreOptions.dry_run} is true and a validator was
 * provided. Returns the blockers for that row (empty array if OK).
 * Adapters add the row index to each returned `{reason}` before
 * surfacing them on {@link RestoreResult.errors}.
 *
 * Validators are typically stateful (tracking seen ids,
 * per-stream version progression). Build a fresh one per
 * `restore` call — see {@link validateRestoreRow} for the canonical
 * factory.
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
 * Pass the returned function as `RestoreOptions.validate` to opt
 * into the standard blocker checks during a dry-run scan.
 *
 * @example
 * ```typescript
 * import { validateRestoreRow } from "@rotorsoft/act";
 *
 * const result = await store.restore(source, {
 *   dry_run: true,
 *   validate: validateRestoreRow(),
 * });
 * for (const err of result.errors) {
 *   console.error(`Row ${err.row}: ${err.reason}`);
 * }
 * ```
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
/**
 * Run a dry-run restore over `source`. Adapter-agnostic — iterates
 * the source, calls `opts.validate` per row if provided, honors
 * `opts.drop_snapshots` and `opts.on_progress`, and returns a
 * {@link RestoreResult} with `dry_run: true`. **No I/O.** The store
 * is never touched, so adapters delegate to this helper directly
 * when `opts.dry_run` is set:
 *
 * ```typescript
 * async restore(source, opts = {}) {
 *   if (opts.dry_run) return runRestoreDryRun(source, opts);
 *   // ...adapter-specific live path...
 * }
 * ```
 *
 * Keeping the dry-run loop in the framework (rather than in each
 * adapter) means the contract — what `dry_run` reports, when
 * `validate` runs, how `on_progress` fires, how `drop_snapshots`
 * counts — lives in exactly one place. Adapters only own the
 * live-write mechanics that differ across backends.
 *
 * The `kept` count reflects what would be written: source row count
 * minus drops (snapshots when `drop_snapshots` is true). Validation
 * doesn't affect `kept` — a row with blockers still counts as kept
 * because adapters wouldn't reject it during live restore (live
 * mode throws atomically on the first error, the row's "would be
 * written" status is hypothetical).
 */
export async function runRestoreDryRun(
  source: AsyncIterable<RestoreRow>,
  opts: RestoreOptions
): Promise<RestoreResult> {
  const started = Date.now();
  const { drop_snapshots = false, on_progress, validate } = opts;
  const errors: Array<{ row: number; reason: string }> = [];
  let kept = 0;
  let droppedSnapshots = 0;
  let rowIdx = 0;
  for await (const row of source) {
    rowIdx++;
    if (on_progress) on_progress({ processed: rowIdx });
    if (validate) {
      for (const r of validate(row, rowIdx))
        errors.push({ row: rowIdx, reason: r.reason });
    }
    if (drop_snapshots && row.name === SNAP_EVENT) {
      droppedSnapshots++;
      continue;
    }
    kept++;
  }
  return {
    kept,
    duration_ms: Date.now() - started,
    dropped: {
      closed_streams: 0,
      snapshots: droppedSnapshots,
      empty_streams: 0,
    },
    dry_run: true,
    errors,
  };
}

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
    // Advance past the source-provided version so subsequent rows
    // don't cascade gap errors after the first one.
    expectedVersionByStream.set(row.stream, row.version + 1);
    return errors;
  };
}
