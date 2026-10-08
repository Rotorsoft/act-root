import { Pool } from "pg";
import { PostgresStore } from "../src/index.js";
import { schema } from "./schema.js";

// The store's jsonb parser is scoped to its OWN Pool: a second,
// independent pg Pool in the same process must not inherit it, or act-pg
// would change how the host app's other pg usage (Drizzle projections,
// ad-hoc queries) reads jsonb. (The payload Date round-trip itself is a
// store TCK case.)
describe("pg per-Pool parser isolation", () => {
  const store = new PostgresStore({
    port: 5431,
    schema: schema("date_rt_1198"),
    table: "date_rt_store",
  });

  beforeAll(async () => {
    await store.drop();
    await store.seed();
  });

  afterAll(async () => {
    await store.drop();
    await store.dispose();
  });

  it("does NOT leak the Date-coercing jsonb parser into an independent Pool", async () => {
    // A second, independent Pool created by the host app for its own
    // purposes. It must read jsonb with pg's default parser (ISO strings
    // stay strings), unaffected by act-pg's per-Pool override.
    const other = new Pool({
      host: "localhost",
      port: 5431,
      user: "postgres",
      password: "postgres",
    });
    try {
      const { rows } = await other.query<{ v: { d: unknown } }>(
        `SELECT '{"d":"2026-07-11T12:34:56.000Z"}'::jsonb AS v`
      );
      // With a GLOBAL parser mutation this would be a Date; with a
      // per-Pool parser it stays a plain string.
      expect(typeof rows[0].v.d).toBe("string");
      expect(rows[0].v.d).toBe("2026-07-11T12:34:56.000Z");
    } finally {
      await other.end();
    }
  });
});
