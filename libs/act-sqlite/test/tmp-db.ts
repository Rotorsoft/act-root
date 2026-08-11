import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Throwaway SQLite databases for specs that need a *fresh, isolated*
 * store per test.
 *
 * `:memory:` is not that: libSQL only serves an in-memory database
 * through a process-wide shared cache (#1443), so two stores pointed at
 * it see each other's schema and rows — and the data outlives
 * `dispose()`. Specs that hand-build a legacy schema, or drop and
 * re-seed, need a genuinely private database, which means a file.
 */
const dir = mkdtempSync(join(tmpdir(), "act-sqlite-"));
let seq = 0;

/** A URL for a database no other test is using. */
export const tmp_db_url = (): string => `file:${join(dir, `t${seq++}.db`)}`;

/** Remove every database this process created. Call from `afterAll`. */
export const rm_tmp_dbs = (): void =>
  rmSync(dir, { recursive: true, force: true });
