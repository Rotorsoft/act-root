import { Pool } from "pg";
import { PostgresStore } from "../src/index.js";

// #1198: payload-Date round-trip and per-Pool parser isolation.
//
// A `Date` committed into event `data` must return as a `Date` (PG's
// JSONB reviver), and — critically — that reviver must be scoped to the
// store's OWN Pool. A second, independent pg Pool in the same process
// must NOT inherit the Date-coercing JSONB parser, or act-pg silently
// mutates how the host app's other pg usage (Drizzle projections,
// ad-hoc queries) reads jsonb.
describe("pg Date round-trip + per-Pool parser isolation (#1198)", () => {
  const store = new PostgresStore({
    port: 5431,
    schema: "date_rt_1198",
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

  it("returns a payload Date as a Date instance", async () => {
    const when = new Date("2026-07-11T12:34:56.000Z");
    await store.commit(
      "dr-stream",
      [{ name: "E", data: { when, label: "not-a-date" } }],
      { correlation: "", causation: {} }
    );
    const got: Array<{ when: unknown; label: unknown }> = [];
    await store.query<Record<string, never>>(
      (e) => got.push(e.data as { when: unknown; label: unknown }),
      { stream: "dr-stream", stream_exact: true }
    );
    expect(got).toHaveLength(1);
    expect(got[0].when).toBeInstanceOf(Date);
    expect((got[0].when as Date).getTime()).toBe(when.getTime());
    // A non-ISO string stays a string.
    expect(got[0].label).toBe("not-a-date");
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
