import { Pool } from "pg";
import { PostgresStore } from "../src/index.js";

/**
 * ACT-980: the retry-seed fix must take effect on databases created before
 * the change without an operator migration. `CREATE TABLE IF NOT EXISTS`
 * never rewrites an existing column default, so `subscribe` seeds `retry = -1`
 * explicitly rather than relying on the column default. This proves a
 * pre-ACT-980 table (retry default 0) still gives new subscriptions
 * retry = -1, so their first claim returns retry = 0.
 */
describe("pg retry seed is migration-free", () => {
  const schema = "retry_compat";
  const table = "rc";
  const fqs = `"${schema}"."${table}_streams"`;

  it("subscribe seeds retry=-1 even when the column default is 0", async () => {
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
      // Simulate a deployment created before ACT-980.
      await pool.query(`ALTER TABLE ${fqs} ALTER COLUMN retry SET DEFAULT 0`);
      await s.subscribe([{ stream: "compat-1" }]);
      const { rows } = await pool.query(
        `SELECT retry FROM ${fqs} WHERE stream = 'compat-1'`
      );
      expect(rows[0].retry).toBe(-1);
    } finally {
      await pool.end();
      await s.dispose();
    }
  });
});
