/**
 * Overlapping full closes on Postgres. Two Acts over one store stand in
 * for two processes: each has its own process-local close lock, so only
 * the head re-check before the truncate keeps the first closer from
 * deleting a commit the second one let through after reseeding. The case
 * where both closes truncate is covered in core (`close.spec.ts`).
 */
import {
  act,
  ConcurrencyError,
  cache,
  dispose,
  StreamClosedError,
  state,
  store,
} from "@rotorsoft/act";
import type { PoolClient } from "pg";
import { z } from "zod";
import { PostgresStore } from "../src/postgres-store.js";
import { schema } from "./schema.js";

const PORT = 5431;
const SCHEMA = schema("act_close_race");

const Tally = state({ Tally: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ added: z.object({ by: z.number() }) })
  .patch({ added: ({ data }, s) => ({ n: s.n + data.by }) })
  .on({ add: z.object({ by: z.number() }) })
  .emit((a) => ["added", { by: a.by }])
  .build();

const actor = { id: "pg", name: "pg" };
const build = () => act().withState(Tally).build();

function parked_close(app: ReturnType<typeof build>, stream: string) {
  let entered!: () => void;
  let release!: () => void;
  const in_archive = new Promise<void>((r) => (entered = r));
  const gate = new Promise<void>((r) => (release = r));
  const done = app.close([
    {
      stream,
      restart: true,
      archive: async () => {
        entered();
        await gate;
      },
    },
  ]);
  return { done, in_archive, release };
}

describe("PostgresStore — overlapping full closes", () => {
  beforeAll(async () => {
    store(new PostgresStore({ port: PORT, schema: SCHEMA, table: "events" }));
    await store().drop();
    await store().seed();
  });

  beforeEach(async () => {
    await store().drop();
    await store().seed();
    await cache().clear();
  });

  afterAll(async () => {
    await dispose()("EXIT").catch(() => {});
  });

  it("refuses a commit that stalled across a full close, and the stream stays closed", async () => {
    const app = build();
    const pg = store() as PostgresStore;
    for (let i = 0; i < 2; i++)
      await app.do("add", { stream: "stalled", actor }, { by: 1 });
    const held = pg as unknown as {
      _client: (op: string) => Promise<PoolClient>;
    };
    const checkout = held._client.bind(pg);
    vi.spyOn(held, "_client").mockImplementationOnce(async (op) => {
      const client = await checkout(op);
      const query = client.query.bind(client) as (
        ...args: unknown[]
      ) => Promise<unknown>;
      (client as unknown as { query: unknown }).query = async (
        ...args: unknown[]
      ) => {
        if (String(args[0]).startsWith("WITH l AS")) {
          (client as unknown as { query: unknown }).query = query;
          await app.close([{ stream: "stalled" }]);
        }
        return query(...args);
      };
      return client;
    });

    await expect(
      app.do("add", { stream: "stalled", actor }, { by: 100 })
    ).rejects.toBeInstanceOf(ConcurrencyError);
    vi.restoreAllMocks();

    await expect(
      app.do("add", { stream: "stalled", actor }, { by: 1 })
    ).rejects.toBeInstanceOf(StreamClosedError);
    const names: string[] = [];
    await pg.query((e) => names.push(e.name as string), {
      stream: "stalled",
      stream_exact: true,
    });
    expect(names).toEqual(["__tombstone__"]);
  });

  it("refuses a head that moved, even with no version to expect", async () => {
    const pg = store() as PostgresStore;
    const meta = { correlation: "", causation: {} };
    const ev = [{ name: "added", data: { by: 1 } }];
    const held = pg as unknown as {
      _client: (op: string) => Promise<PoolClient>;
    };
    const checkout = held._client.bind(pg);
    vi.spyOn(held, "_client").mockImplementationOnce(async (op) => {
      const client = await checkout(op);
      const query = client.query.bind(client) as (
        ...args: unknown[]
      ) => Promise<unknown>;
      (client as unknown as { query: unknown }).query = async (
        ...args: unknown[]
      ) => {
        if (String(args[0]).startsWith("WITH l AS")) {
          (client as unknown as { query: unknown }).query = query;
          await new PostgresStore({
            port: PORT,
            schema: SCHEMA,
            table: "events",
          }).commit("moved", ev, meta);
        }
        return query(...args);
      };
      return client;
    });
    await expect(pg.commit("moved", ev, meta)).rejects.toBeInstanceOf(
      ConcurrencyError
    );
    vi.restoreAllMocks();
  });

  it("subscribing in different orders doesn't deadlock", async () => {
    const pg = store() as PostgresStore;
    const rival = new PostgresStore({
      port: PORT,
      schema: SCHEMA,
      table: "events",
    });
    for (let round = 0; round < 4; round++) {
      const streams = Array.from({ length: 40 }, (_, i) => ({
        stream: `order-${round}-${i}`,
      }));
      await Promise.all([
        pg.subscribe(streams),
        rival.subscribe([...streams].reverse()),
      ]);
    }
    await rival.dispose();
  }, 20_000);

  it("keeps a commit accepted after another app reseeded the stream", async () => {
    const app1 = build();
    const app2 = build();
    for (let i = 0; i < 3; i++)
      await app1.do("add", { stream: "r1", actor }, { by: 1 });
    const a = parked_close(app1, "r1");
    await a.in_archive;
    await app2.close([{ stream: "r1", restart: true }]);
    await app2.do("add", { stream: "r1", actor }, { by: 100 });
    a.release();
    expect((await a.done).skipped).toEqual(["r1"]);
    await cache().clear();
    expect((await app2.load(Tally, "r1")).state.n).toBe(103);
  });
});
