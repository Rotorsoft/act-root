/**
 * Scenario A — sustained commit throughput, through the real path
 * (`app.do` → validate → load → emit → commit with optimistic guard).
 *
 *   npx tsx evidence/throughput.ts --events 20000
 *
 * Two shapes:
 *  - hot aggregate: sequential commits on ONE stream — the serialized
 *    floor (every commit loads state and bumps the same version chain).
 *  - many streams: the same commit count across 1k streams with 32
 *    in flight — the shape horizontal scale actually takes.
 */
import { dispose, store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { ACTOR, buildApp, config, human, ms } from "./shared.js";

async function main() {
  const { table, events, pg: pgconf } = config();
  const pgstore = new PostgresStore({ ...pgconf, table: `${table}_tp` });
  await pgstore.seed();
  await pgstore.drop();
  await pgstore.seed();
  store(pgstore);
  const app = buildApp();

  // hot aggregate — sequential, one stream
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < events; i++)
    await app.do("tick", { stream: "hot", actor: ACTOR }, { n: i });
  const hot_ms = ms(t0);
  console.log(
    `hot aggregate : ${human(events)} commits in ${(hot_ms / 1000).toFixed(1)}s → ${Math.round((events / hot_ms) * 1000)} events/s`
  );

  // many streams — 32 in flight across 1k streams
  const STREAMS = 1_000;
  const INFLIGHT = 32;
  let next = 0;
  t0 = process.hrtime.bigint();
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= events) return;
      await app.do(
        "tick",
        { stream: `s-${i % STREAMS}`, actor: ACTOR },
        { n: i }
      );
    }
  };
  await Promise.all(Array.from({ length: INFLIGHT }, worker));
  const many_ms = ms(t0);
  console.log(
    `many streams  : ${human(events)} commits in ${(many_ms / 1000).toFixed(1)}s → ${Math.round((events / many_ms) * 1000)} events/s (${STREAMS} streams, ${INFLIGHT} in flight)`
  );

  await dispose()();
}

void main();
