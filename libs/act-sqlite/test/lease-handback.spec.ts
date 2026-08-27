import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { act, log, state, ZodEmpty } from "@rotorsoft/act";
import { sandbox } from "@rotorsoft/act/test";
import { z } from "zod";
import { SqliteStore } from "../src/index.js";

/**
 * #1577 — a second connection to the same database file.
 *
 * `SqliteStore` owns one connection, so writes inside an Act never contend.
 * An application that opens its own `createClient()` on the same path adds a
 * second writer, and SQLite allows only one: with `busy_timeout` at its
 * default of 0, the loser fails instantly.
 *
 * The contention here is real — two connections, one file, a genuinely held
 * write transaction — rather than a mocked `SQLITE_BUSY` return. A mock would
 * prove the handler fires when hand-fed the state, not that the state occurs.
 *
 * `busy_timeout` is deliberately left unset. Raising it does not let the
 * write succeed; it blocks the Node event loop for the whole wait, which
 * prevents the other connection's commit from ever running. See #1577.
 */

const DB_PATH = join(import.meta.dirname, "lease-handback.db");
const actor = { id: "a", name: "a" };

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Bumped: ZodEmpty })
  .patch({ Bumped: (_e, s) => ({ count: s.count + 1 }) })
  .on({ bump: ZodEmpty })
  .emit(() => ["Bumped", {}])
  .build();

const cleanup = () => {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(DB_PATH + ext);
    } catch {
      // may not exist
    }
  }
};

describe("correlation lease handback under a contended file (#1577)", () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it("shuts down cleanly and explains the skipped handback", async () => {
    const warnings: string[] = [];
    const errors: string[] = [];
    const real_warn = log().warn.bind(log());
    const real_error = log().error.bind(log());
    (log() as unknown as { warn: unknown }).warn = (e: unknown) => {
      warnings.push(e instanceof Error ? e.message : String(e));
    };
    (log() as unknown as { error: unknown }).error = (e: unknown) => {
      errors.push(e instanceof Error ? e.message : String(e));
    };

    const { app, dispose } = await sandbox(act().withState(Counter), {
      store: () => new SqliteStore({ url: `file:${DB_PATH}` }),
    });
    await app.do("bump", { stream: "c1", actor }, {});
    await app.correlate();

    // A second connection takes the write lock and holds it.
    const other = createClient({ url: `file:${DB_PATH}` });
    const tx = await other.transaction("write");
    await tx.execute(
      "INSERT INTO events (stream, version, name, data, meta, created) VALUES ('x', 0, 'X', '{}', '{}', '2026-01-01')"
    );

    // Shutdown hands the correlation lease back, which needs a write.
    await app.shutdown();

    await tx.rollback().catch(() => undefined);
    other.close();
    (log() as unknown as { warn: unknown }).warn = real_warn;
    (log() as unknown as { error: unknown }).error = real_error;
    await dispose();

    // The failure is benign — the lease carries its own expiry — so the
    // operator is told that, rather than handed a bare SQLITE_BUSY stack
    // that reads as a fatal shutdown fault.
    const reported = warnings.find((m) => /correlation lease/i.test(m));
    expect(reported).toBeDefined();
    expect(reported).toMatch(/expire/i);
    expect(reported).toMatch(/SQLITE_BUSY|locked/i);

    // Severity is part of the contract, not a detail: operators page on
    // `error`, and a clean Ctrl-C must not page. Nothing about the handback
    // may reach that level.
    expect(errors.filter((m) => /correlation lease/i.test(m))).toEqual([]);
  }, 30_000);
});
