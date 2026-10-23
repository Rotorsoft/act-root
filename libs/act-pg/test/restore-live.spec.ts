import {
  act,
  type Committed,
  type EventSource,
  InMemoryCache,
  InMemoryStore,
  type Query,
  type Schemas,
  sleep,
  state,
} from "@rotorsoft/act";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PostgresStore } from "../src/postgres-store.js";
import { schema } from "./schema.js";

/**
 * A restore into a live app on Postgres. A correlate scan that read the old
 * log sends its mark write while the restore's transaction holds the locks;
 * the write waits, then lands after COMMIT, into the restored log. The
 * restore must wait for the pass instead, so the restored events still
 * reach their reactions.
 */
const Tick = state({ PgRestoreTick: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Ticked: z.object({}) })
  .patch({ Ticked: (_e, s) => ({ n: s.n + 1 }) })
  .on({ tick: z.object({}) })
  .emit(() => ["Ticked", {}])
  .build();
const actor = { id: "r", name: "r" };

/** Holds the reply of the first correlate scan that reads events. */
class HoldingStore extends PostgresStore {
  holding = false;
  reached: () => void = () => {};
  release: () => void = () => {};
  override async query<E extends Schemas>(
    callback: (event: Committed<E, keyof E>) => void,
    query?: Query
  ) {
    const count = await super.query(callback, query);
    if (this.holding && count > 0 && query?.with_pii === false) {
      this.holding = false;
      const held = new Promise<void>((r) => {
        this.release = r;
      });
      this.reached();
      await held;
    }
    return count;
  }
}

/** Three events to restore, behind a gate that keeps the restore open. */
async function gated_source(gate: Promise<void>): Promise<EventSource> {
  const src = new InMemoryStore();
  for (let i = 0; i < 3; i++)
    await src.commit(`restored-${i}`, [{ name: "Ticked", data: {} }], {
      correlation: "c",
      causation: {},
    });
  return {
    async query(callback, query) {
      await gate;
      return src.query(callback as never, query);
    },
    async dispose() {},
  };
}

describe("a restore into a live app on Postgres", () => {
  const run = async (scan_in_flight: boolean) => {
    const store = new HoldingStore({
      port: 5431,
      schema: schema(scan_in_flight ? "restore_live" : "restore_idle"),
      table: "events",
    });
    await store.drop();
    await store.seed();
    let seen = 0;
    const app = act()
      .withState(Tick)
      .on("Ticked")
      .do(async function count() {
        seen++;
      })
      .to((e) => ({ target: `count-${e.stream}` }))
      .build({
        scoped: { store, cache: new InMemoryCache() },
        autoSettle: false,
      });
    try {
      for (let i = 0; i < 10; i++)
        await app.do("tick", { stream: "before", actor }, {});
      let open!: () => void;
      const source = await gated_source(
        new Promise<void>((r) => {
          open = r;
        })
      );
      let in_flight: Promise<unknown> | undefined;
      if (scan_in_flight) {
        store.holding = true;
        const reached = new Promise<void>((r) => {
          store.reached = r;
        });
        in_flight = app.correlate();
        await reached; // the scan read the old log
      }
      const restoring = app.restore(source, {});
      // Give a restore that doesn't wait for the scan time to truncate and
      // block on its source, then send the scan's write behind its locks.
      await sleep(200);
      store.release();
      await sleep(200);
      open();
      await restoring;
      await in_flight;
      for (let i = 0; i < 6; i++) {
        await app.correlate();
        await app.drain();
      }
      return seen;
    } finally {
      await app.shutdown();
      await store.drop();
      await store.dispose();
    }
  };

  it("delivers restored events when a scan's write was sent during the restore", async () => {
    expect(await run(true)).toBe(3);
  }, 20_000);

  it("control — delivers them with no scan in flight", async () => {
    expect(await run(false)).toBe(3);
  }, 20_000);
});
