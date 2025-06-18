// @rotorsoft/act@0.3.0
import type {
  Committed,
  EventMeta,
  Lease,
  Message,
  Query,
  Schemas,
  Store,
} from "@rotorsoft/act";
import { ConcurrencyError, SNAP_EVENT, logger } from "@rotorsoft/act";
import pg from "pg";
import { config } from "./config";
import { seed_store } from "./seed";
import { dateReviver } from "./utils";

const { Pool, types } = pg;
types.setTypeParser(types.builtins.JSONB, (val) =>
  JSON.parse(val, dateReviver)
);

export class PostgresStore implements Store {
  private _pool = new Pool(config.pg);

  constructor(
    readonly table: string,
    readonly leaseMillis = 30_000
  ) {}
  async dispose() {
    await this._pool.end();
  }

  async seed() {
    const seed = seed_store(this.table);
    await this._pool.query(seed);
  }

  async drop() {
    await this._pool.query(`DROP TABLE IF EXISTS "${this.table}"`);
    await this._pool.query(`DROP TABLE IF EXISTS "${this.table}_streams"`);
  }

  async query<E extends Schemas>(
    callback: (event: Committed<E, keyof E>) => void,
    query?: Query,
    withSnaps = false
  ) {
    const {
      stream,
      names,
      before,
      after,
      limit,
      created_before,
      created_after,
      backward,
      correlation,
    } = query || {};

    let sql = `SELECT * FROM "${this.table}" WHERE`;
    const values: any[] = [];

    if (withSnaps)
      sql = sql.concat(
        ` id>=COALESCE((SELECT id
            FROM "${this.table}"
            WHERE stream='${stream}' AND name='${SNAP_EVENT}'
            ORDER BY id DESC LIMIT 1), 0)
            AND stream='${stream}'`
      );
    else if (query) {
      if (typeof after !== "undefined") {
        values.push(after);
        sql = sql.concat(" id>$1");
      } else sql = sql.concat(" id>-1");
      if (stream) {
        values.push(stream);
        sql = sql.concat(` AND stream=$${values.length}`);
      }
      if (names && names.length) {
        values.push(names);
        sql = sql.concat(` AND name = ANY($${values.length})`);
      }
      if (before) {
        values.push(before);
        sql = sql.concat(` AND id<$${values.length}`);
      }
      if (created_after) {
        values.push(created_after.toISOString());
        sql = sql.concat(` AND created>$${values.length}`);
      }
      if (created_before) {
        values.push(created_before.toISOString());
        sql = sql.concat(` AND created<$${values.length}`);
      }
      if (correlation) {
        values.push(correlation);
        sql = sql.concat(` AND meta->>'correlation'=$${values.length}`);
      }
    }
    sql = sql.concat(` ORDER BY id ${backward ? "DESC" : "ASC"}`);
    if (limit) {
      values.push(limit);
      sql = sql.concat(` LIMIT $${values.length}`);
    }

    const result = await this._pool.query<Committed<E, keyof E>>(sql, values);
    for (const row of result.rows) callback(row);

    return result.rowCount ?? 0;
  }

  async commit<E extends Schemas>(
    stream: string,
    msgs: Message<E, keyof E>[],
    meta: EventMeta,
    expectedVersion?: number
  ) {
    const client = await this._pool.connect();
    let version = -1;
    try {
      await client.query("BEGIN");

      const last = await client.query<Committed<E, keyof E>>(
        `SELECT version FROM "${this.table}" WHERE stream=$1 ORDER BY version DESC LIMIT 1`,
        [stream]
      );
      version = last.rowCount ? last.rows[0].version : -1;
      if (expectedVersion && version !== expectedVersion)
        throw new ConcurrencyError(
          version,
          msgs as unknown as Message<Schemas, string>[],
          expectedVersion
        );

      const committed = await Promise.all(
        msgs.map(async ({ name, data }) => {
          version++;
          const sql = `
          INSERT INTO "${this.table}"(name, data, stream, version, meta) 
          VALUES($1, $2, $3, $4, $5) RETURNING *`;
          const vals = [name, data, stream, version, meta];
          const { rows } = await client.query<Committed<E, keyof E>>(sql, vals);
          return rows.at(0)!;
        })
      );

      await client
        .query(
          `
            NOTIFY "${this.table}", '${JSON.stringify({
              operation: "INSERT",
              id: committed[0].name,
              position: committed[0].id,
            })}';
            COMMIT;
            `
        )
        .catch((error) => {
          logger.error(error);
          throw new ConcurrencyError(
            version,
            msgs as unknown as Message<Schemas, string>[],
            expectedVersion || -1
          );
        });
      return committed;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async fetch<E extends Schemas>(limit: number) {
    const { rows } = await this._pool.query<{ stream: string; at: number }>(
      `
      SELECT stream, at
      FROM "${this.table}_streams"
      WHERE blocked=false
      ORDER BY at ASC
      LIMIT $1::integer
      `,
      [limit]
    );

    const after = rows.length
      ? rows.reduce((min, r) => Math.min(min, r.at), Number.MAX_SAFE_INTEGER)
      : -1;

    const events: Committed<E, keyof E>[] = [];
    await this.query<E>((e) => events.push(e), { after, limit });
    return { streams: rows.map(({ stream }) => stream), events };
  }

  async lease(leases: Lease[]) {
    const { by, at } = leases.at(0)!;
    const streams = leases.map(({ stream }) => stream);
    const client = await this._pool.connect();

    try {
      await client.query("BEGIN");
      // insert new streams
      await client.query(
        `
        INSERT INTO "${this.table}_streams" (stream)
        SELECT UNNEST($1::text[])
        ON CONFLICT (stream) DO NOTHING
        `,
        [streams]
      );
      // set leases
      const { rows } = await client.query<{
        stream: string;
        leased_at: number;
        retry: number;
      }>(
        `
        WITH free AS (
          SELECT * FROM "${this.table}_streams" 
          WHERE stream = ANY($1::text[]) AND (leased_by IS NULL OR leased_until <= NOW())
          FOR UPDATE
        )
        UPDATE "${this.table}_streams" U
        SET
          leased_by = $2::uuid,
          leased_at = $3::integer,
          leased_until = NOW() + ($4::integer || ' milliseconds')::interval
        FROM free
        WHERE U.stream = free.stream
        RETURNING U.stream, U.leased_at, U.retry
        `,
        [streams, by, at, this.leaseMillis]
      );
      await client.query("COMMIT");

      return rows.map(({ stream, leased_at, retry }) => ({
        stream,
        by,
        at: leased_at,
        retry,
        block: false,
      }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async ack(leases: Lease[]) {
    const client = await this._pool.connect();

    try {
      await client.query("BEGIN");
      for (const { stream, by, at, retry, block } of leases) {
        await client.query(
          `UPDATE "${this.table}_streams"
          SET
            at = $3::integer,
            retry = $4::integer,
            blocked = $5::boolean,
            leased_by = NULL,
            leased_at = NULL,
            leased_until = NULL
          WHERE
            stream = $1::text
            AND leased_by = $2::uuid`,
          [stream, by, at, retry, block]
        );
      }
      await client.query("COMMIT");
    } catch {
      // leased_until fallback
      await client.query("ROLLBACK").catch(() => {});
    } finally {
      client.release();
    }
  }
}
