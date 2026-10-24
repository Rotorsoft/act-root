/**
 * Scale benchmark: how long one worker, or several competing workers, take to
 * drain a full backlog of N streams.
 *
 * Each worker is its own Act: one Act runs one drain at a time, so only
 * separate instances compete for streams through FOR UPDATE SKIP LOCKED.
 * Before every timed round, `reset` rewinds each stream's watermark to -1
 * (the work mark stays), so every round claims, fetches, handles and acks
 * the whole backlog again instead of timing an empty drain. A worker drains
 * until a claim comes back empty, and every round must ack every stream. The
 * apps don't auto-settle, so nothing drains the backlog behind the bench's
 * back.
 *
 * Run: pnpm bench:micro libs/act-pg/bench/drain-scale.micro.bench.ts
 */
import { act, dispose, state, store, ZodEmpty } from "@rotorsoft/act";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PostgresStore } from "../src/postgres-store.js";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: ZodEmpty })
  .patch({ Incremented: (_, s) => ({ count: s.count + 1 }) })
  .on({ increment: ZodEmpty })
  .emit(() => ["Incremented", {}])
  .build();

const EVENTS_PER_STREAM = 5;
const ROUNDS = 10;

function pgStore() {
  return new PostgresStore({
    port: 5431,
    schema: "drain_scale",
    table: "events",
  });
}

const worker = () =>
  act()
    .withState(Counter)
    .on("Incremented")
    .do(async function handle() {})
    .build({ autoSettle: false });

/** N streams of EVENTS_PER_STREAM events each, correlated so they carry a work mark. */
async function seed(n: number) {
  await dispose()();
  store(pgStore());
  await store().drop();
  await store().seed();
  const streams = Array.from({ length: n }, (_, i) => `s-${i}`);
  const events = Array.from({ length: EVENTS_PER_STREAM }, () => ({
    name: "Incremented",
    data: {},
  }));
  for (const stream of streams)
    await store().commit(stream, events, { correlation: "", causation: {} });
  await worker().correlate({ limit: n * EVENTS_PER_STREAM + 1 });
  return streams;
}

for (const [workers, streams] of [
  [1, 50],
  [1, 200],
  [1, 500],
  [1, 1000],
  [3, 100],
  [3, 500],
  [5, 100],
  [5, 500],
] as const) {
  describe(`${workers} worker${workers > 1 ? "s" : ""} × ${streams} streams`, () => {
    it("drains the whole backlog", async ({ bench }) => {
      const names = await seed(streams);
      const apps = Array.from({ length: workers }, worker);
      const limit = Math.ceil(streams / workers);
      const short: number[] = [];
      await bench(
        `drain ${streams} streams with ${workers} worker${workers > 1 ? "s" : ""}`,
        {
          // reset arms each app's drain, and only that app's
          async beforeEach() {
            await Promise.all(apps.map((app) => app.reset(names)));
          },
        },
        async () => {
          const acked = new Set<string>();
          await Promise.all(
            apps.map(async (app) => {
              for (;;) {
                const d = await app.drain({
                  streamLimit: limit,
                  eventLimit: EVENTS_PER_STREAM,
                  leaseMillis: 10_000,
                });
                if (!d.leased.length) return;
                for (const lease of d.acked) acked.add(lease.stream);
              }
            })
          );
          if (acked.size < streams) short.push(acked.size);
        }
      ).run({
        iterations: ROUNDS,
        time: 0,
        warmupIterations: 2,
        warmupTime: 0,
      });
      // every round drained the whole backlog
      expect(short).toEqual([]);
    });
  });
}
