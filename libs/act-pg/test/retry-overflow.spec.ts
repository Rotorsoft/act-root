import { Pool } from "pg";
import { PostgresStore } from "../src/index.js";

/**
 * #1190: `streams.retry` was `smallint` (max 32767). `claim()` does
 * `retry = retry + 1` on every acquisition, and a persistently failing
 * `blockOnError: false` stream is re-claimed forever — so a zero-progress
 * poison stream marches its retry counter toward the smallint ceiling.
 * At 32768 the whole multi-stream claim UPDATE raised "smallint out of
 * range", killing `claim()` for the lane permanently. Widening the column
 * to `int` (via the additive seed ladder) lifts the ceiling to match the
 * unbounded SQLite/InMemory adapters.
 */
describe("pg streams.retry does not overflow at the smallint ceiling", () => {
  const schema = "retry_overflow";
  const table = "ro";
  const fqs = `"${schema}"."${table}_streams"`;

  it("claims a stream whose retry sits at the old smallint ceiling", async () => {
    const s = new PostgresStore({ port: 5431, schema, table });
    const pool = new Pool({
      host: "localhost",
      port: 5431,
      user: "postgres",
      password: "postgres",
      database: "postgres",
    });
    try {
      await s.drop();
      await s.seed();
      await s.subscribe([{ stream: "poison-1" }]);
      // Park retry one below the old smallint ceiling. Before the fix the
      // very next claim's `retry + 1` overflows the smallint UPDATE.
      await pool.query(
        `UPDATE ${fqs} SET retry = 32767 WHERE stream = 'poison-1'`
      );

      // Commit an event so the stream lags and is claimable.
      await s.commit("poison-1", [{ name: "Poison", data: {} }], {
        correlation: "c",
        causation: {},
      } as never);

      const leases = await s.claim(10, 0, "worker", 10_000);
      const lease = leases.find((l) => l.stream === "poison-1");
      expect(lease).toBeDefined();
      // Past the old ceiling — this row would have thrown pre-fix.
      expect(lease!.retry).toBe(32768);

      const { rows } = await pool.query(
        `SELECT retry FROM ${fqs} WHERE stream = 'poison-1'`
      );
      expect(rows[0].retry).toBe(32768);
    } finally {
      await pool.end();
      await s.dispose();
    }
  });
});
