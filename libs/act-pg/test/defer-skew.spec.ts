/**
 * A defer wake must survive this process's clock running ahead of the
 * database's (#1753). The wake fires on the app clock, but Postgres
 * releases the stream on `deferred_at <= NOW()`, its own clock, so the
 * first drain after the wake claims nothing and the stream has to be
 * re-parked rather than forgotten. `created` is stamped by the database, so
 * the defer has to be longer than the skew for the wake to come early
 * (a shorter one is already due by the app clock and runs at once).
 */
import { act, dispose, sleep, state, store, ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";
import { PostgresStore } from "../src/postgres-store.js";
import { schema } from "./schema.js";

const SCHEMA = schema("act_defer_skew");
const actor = { id: "pg", name: "pg" };
const Pinger = state({ Pinger: z.object({}) })
  .init(() => ({}))
  .emits({ Pinged: ZodEmpty })
  .on({ ping: ZodEmpty })
  .emit(() => ["Pinged", {}])
  .build();

describe("PostgresStore — defer wake with the app clock ahead of the database", () => {
  beforeEach(async () => {
    store(new PostgresStore({ port: 5431, schema: SCHEMA, table: "events" }));
    await store().drop();
    await store().seed();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await dispose()("EXIT").catch(() => {});
  });

  async function fired(skew_ms: number) {
    // Fake only Date, so this process reads a clock `skew_ms` ahead while
    // timers and the database keep real time.
    vi.useFakeTimers({
      toFake: ["Date"],
      shouldAdvanceTime: true,
      now: Date.now() + skew_ms,
    });
    const ran: string[] = [];
    const app = act()
      .withState(Pinger)
      .withLane({ name: "later", cycleMs: 200, leaseMillis: 1 })
      .on("Pinged")
      .defer((e) => ({ at: new Date(e.created.getTime() + 2_000) }))
      .do(async function remind(e) {
        ran.push(e.stream);
      })
      .to((e) => ({ target: `r-${e.stream}`, lane: "later" }))
      .build();
    await app.do("ping", { stream: "p", actor }, {});
    await app.correlate();
    await sleep(4_000);
    return ran;
  }

  it("fires with synchronized clocks", async () => {
    expect(await fired(0)).toEqual(["p"]);
  }, 10_000);

  it("fires when the app clock is 800ms ahead of the database", async () => {
    expect(await fired(800)).toEqual(["p"]);
  }, 10_000);
});
