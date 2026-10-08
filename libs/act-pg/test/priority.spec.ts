/**
 * `PostgresStore` priority: the seed migration that adds the column to an
 * older table, and the boot path that restores declared priorities. The
 * portable priority contract (max on subscribe, prioritize filters, claim
 * order) lives in the store TCK.
 */

import { act, dispose, state, store, ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";
import { PostgresStore } from "../src/postgres-store.js";
import { schema } from "./schema.js";

const PORT = 5431;
const SCHEMA = schema("act_priority_test");
const TABLE = "events";

describe("PostgresStore priority migration", () => {
  beforeEach(async () => {
    store(new PostgresStore({ port: PORT, schema: SCHEMA, table: TABLE }));
    await store().drop();
    await store().seed();
  });

  afterEach(async () => {
    await dispose()("EXIT").catch(() => {});
  });

  it("seed migration is idempotent — adding priority on existing tables", async () => {
    // Drop + manually create an old-shape table without `priority`,
    // then call seed() and verify the column was added.
    const pool = (store() as any)._pool;
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
    await pool.query(`
      CREATE TABLE "${SCHEMA}"."${TABLE}_streams" (
        stream varchar(100) PRIMARY KEY,
        source varchar(100),
        at int NOT NULL DEFAULT -1,
        retry smallint NOT NULL DEFAULT 0,
        blocked boolean NOT NULL DEFAULT false,
        error text,
        leased_by text,
        leased_until timestamptz
      )`);
    // events table needed for the SELECT MAX(id) in subsequent calls.
    await pool.query(`
      CREATE TABLE "${SCHEMA}"."${TABLE}" (
        id serial PRIMARY KEY,
        name varchar(100) NOT NULL,
        data jsonb,
        stream varchar(100) NOT NULL,
        version int NOT NULL,
        created timestamptz NOT NULL DEFAULT now(),
        meta jsonb
      )`);
    await pool.query(
      `CREATE UNIQUE INDEX ON "${SCHEMA}"."${TABLE}" (stream, version)`
    );

    // Pre-existing row without priority — uses table default.
    await pool.query(
      `INSERT INTO "${SCHEMA}"."${TABLE}_streams" (stream) VALUES ('legacy')`
    );

    await store().seed(); // idempotent re-seed should add priority col.

    const seen: any[] = [];
    await store().query_streams((p) => seen.push(p), { stream: "legacy" });
    expect(seen[0].priority).toBe(0);
  });
});

/**
 * The app-level path into the duplicate-batch merge. Two static
 * reactions to one target from different sources are a supported shape
 * (`lanes.spec.ts` "accepts same-target reactions on the SAME lane across
 * sources"), `classify_registry` keys them separately, and correlate's init
 * passes the whole list to one `subscribe` call.
 */
describe("static-target batch after a lower stored priority", () => {
  const Counter = state({ Counter: z.object({ n: z.number() }) })
    .init(() => ({ n: 0 }))
    .emits({ Incremented: ZodEmpty })
    .patch({ Incremented: (_e, s) => ({ n: s.n + 1 }) })
    .on({ Increment: ZodEmpty })
    .emit(() => ["Incremented", {}])
    .build();

  beforeEach(async () => {
    store(
      new PostgresStore({
        port: PORT,
        schema: schema("act_dup_batch_test"),
        table: TABLE,
      })
    );
    await store().drop();
    await store().seed();
  });

  afterEach(async () => {
    await dispose()("EXIT").catch(() => {});
  });

  it("restores the declared maximum priority on boot", async () => {
    // What a deploy that raises declared priorities, or a `prioritize()`
    // override, leaves behind: a stored value below BOTH declared entries.
    await store().subscribe([{ stream: "shared", priority: 0 }]);

    const app = act()
      .withState(Counter)
      .on("Incremented")
      .do(function reactA() {
        return Promise.resolve();
      })
      .to({ target: "shared", source: "sA", priority: 1 })
      .on("Incremented")
      .do(function reactB() {
        return Promise.resolve();
      })
      .to({ target: "shared", source: "sB", priority: 7 })
      .build();
    // Forces correlate's init, which subscribes the static batch.
    await app.correlate();

    const seen: { priority: number }[] = [];
    await store().query_streams((p) => seen.push(p as never), {
      stream: "shared",
      stream_exact: true,
    });
    expect(seen[0].priority).toBe(7);
    await app.shutdown();
  });
});
