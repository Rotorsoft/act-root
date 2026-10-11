import { act, dispose, sleep, state, store, ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";
import { PostgresStore } from "../src/postgres-store.js";
import { schema } from "./schema.js";

const SCHEMA = schema("act_defer_skew");
const actor = { id: "pg", name: "pg" };
const S = state({ PS: z.object({}) })
  .init(() => ({}))
  .emits({ Pinged: ZodEmpty })
  .on({ ping: ZodEmpty })
  .emit(() => ["Pinged", {}])
  .build();

/**
 * A worker whose clock runs ahead of the database's must still deliver
 * defers and backoff retries (#1753). Both persist an absolute
 * `deferred_at`, which the worker's own timer waits for; Postgres judges it
 * by the claiming worker's clock too, so the wake and the claim agree. Only
 * `Date` is faked, so timers and the database keep real time.
 */
describe("PostgresStore — worker clock 800ms ahead of the database", () => {
  beforeEach(async () => {
    store(new PostgresStore({ port: 5431, schema: SCHEMA, table: "events" }));
    await store().drop();
    await store().seed();
    vi.useFakeTimers({
      toFake: ["Date"],
      shouldAdvanceTime: true,
      now: Date.now() + 800,
    });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await dispose()("EXIT").catch(() => {});
  });

  it("delivers a defer", async () => {
    const ran: string[] = [];
    const app = act()
      .withState(S)
      .withLane({ name: "l", cycleMs: 200, leaseMillis: 1 })
      .on("Pinged")
      .defer((e) => ({ at: new Date(e.created.getTime() + 2_000) }))
      .do(async function r(e) {
        ran.push(e.stream);
      })
      .to((e) => ({ target: `r-${e.stream}`, lane: "l" }))
      .build();
    await app.do("ping", { stream: "p", actor }, {});
    await app.correlate();
    // Wait for delivery rather than a fixed delay: the defer is 2 s out and a
    // slow runner can need more than a fixed margin to run the lane cycle.
    await vi.waitFor(() => expect(ran).toEqual(["p"]), {
      timeout: 8_000,
      interval: 100,
    });
  }, 10_000);

  it("retries with backoff", async () => {
    let attempts = 0;
    const app = act()
      .withState(S)
      .withLane({ name: "l", cycleMs: 200, leaseMillis: 1 })
      .on("Pinged")
      .do(
        async function r() {
          if (++attempts === 1) throw new Error("once");
        },
        { maxRetries: 3, backoff: { strategy: "fixed", baseMs: 300 } }
      )
      .to((e) => ({ target: `r-${e.stream}`, lane: "l" }))
      .build();
    await app.do("ping", { stream: "b", actor }, {});
    await app.correlate();
    await sleep(3_000);
    expect(attempts).toBe(2);
  }, 10_000);
});
