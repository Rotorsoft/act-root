/**
 * Correlation checkpoint benchmarks — three scenarios:
 *
 * 1. Static-only: settle with no dynamic resolvers (should skip correlate)
 * 2. Dynamic checkpoint: large history, scan from checkpoint vs from 0
 * 3. Cold-start: first correlate after bootstrap
 *
 * Run: npx tsx libs/act-pg/test/correlate-checkpoint.bench.ts
 */
import { act, state, store, ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";
import { PostgresStore } from "../src/PostgresStore.js";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: ZodEmpty })
  .patch({ Incremented: (_, s) => ({ count: s.count + 1 }) })
  .on({ increment: ZodEmpty })
  .emit(() => ["Incremented", {}])
  .build();

const Stats = state({ Stats: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ StatUpdated: ZodEmpty })
  .patch({ StatUpdated: (_, s) => ({ count: s.count + 1 }) })
  .on({ UpdateStat: ZodEmpty })
  .emit("StatUpdated")
  .build();

const noop = async () => {};
const actor = { id: "a", name: "a" };

function pgStore() {
  return new PostgresStore({
    port: 5431,
    schema: "checkpoint_bench",
    table: "events",
  });
}

async function reset() {
  store(pgStore());
  await store().drop();
  await store().seed();
}

// ━━━ Benchmark 1: Static-only settle (no dynamic resolvers) ━━━
async function benchStaticOnly(events: number, cycles: number) {
  await reset();
  // Static resolvers only — _this_ default
  const app_ = act().withState(Counter).on("Incremented").do(noop).build();

  for (let i = 0; i < events; i++) {
    await app_.do("increment", { stream: `s-${i}`, actor }, {});
  }

  // Bootstrap
  await app_.correlate({ limit: events * 2 });
  await app_.drain({ streamLimit: events, eventLimit: 50, leaseMillis: 1 });

  // Add a few new events
  for (let i = 0; i < 5; i++) {
    await app_.do("increment", { stream: `s-${i}`, actor }, {});
  }

  // Measure: correlate-only cycles (isolate correlate cost)
  const start = performance.now();
  for (let i = 0; i < cycles; i++) {
    await app_.correlate({ limit: 200 });
  }
  const elapsed = performance.now() - start;

  return { elapsed, perCycle: elapsed / cycles };
}

// ━━━ Benchmark 2: Dynamic resolver with large history ━━━
async function benchDynamicCheckpoint(events: number, cycles: number) {
  await reset();
  // Dynamic resolver — target depends on event stream
  const app_ = act()
    .withState(Counter)
    .withState(Stats)
    .on("Incremented")
    .do(noop)
    .to((event) => ({
      target: `stats-${event.stream}`,
      source: event.stream,
    }))
    .build();

  for (let i = 0; i < events; i++) {
    await app_.do("increment", { stream: `s-${i}`, actor }, {});
  }

  // Bootstrap
  for (let pass = 0; pass < 5; pass++) {
    const { subscribed } = await app_.correlate({ limit: events * 2 });
    if (subscribed === 0 && pass > 0) break;
    await app_.drain({
      streamLimit: events,
      eventLimit: 50,
      leaseMillis: 1,
    });
  }

  // Add new events
  for (let i = 0; i < 5; i++) {
    await app_.do("increment", { stream: `s-new-${i}`, actor }, {});
  }

  // Measure: correlate-only cycles (isolate correlate cost)
  const start = performance.now();
  for (let i = 0; i < cycles; i++) {
    await app_.correlate({ limit: 200 });
  }
  const elapsed = performance.now() - start;

  return { elapsed, perCycle: elapsed / cycles };
}

// ━━━ Benchmark 3: Cold-start first correlate ━━━
async function benchColdStart(events: number) {
  await reset();
  const app_ = act()
    .withState(Counter)
    .on("Incremented")
    .do(noop)
    .to((event) => ({
      target: `stats-${event.stream}`,
      source: event.stream,
    }))
    .build();

  for (let i = 0; i < events; i++) {
    await app_.do("increment", { stream: `s-${i}`, actor }, {});
  }

  // Bootstrap fully
  for (let pass = 0; pass < 5; pass++) {
    const { subscribed } = await app_.correlate({ limit: events * 2 });
    if (subscribed === 0 && pass > 0) break;
    await app_.drain({
      streamLimit: events,
      eventLimit: 50,
      leaseMillis: 1,
    });
  }

  // Simulate cold start — new Act instance (fresh checkpoint)
  const app2 = act()
    .withState(Counter)
    .on("Incremented")
    .do(noop)
    .to((event) => ({
      target: `stats-${event.stream}`,
      source: event.stream,
    }))
    .build();

  // Measure: first correlate on "cold" instance
  const start = performance.now();
  await app2.correlate({ limit: events * 2 });
  const elapsed = performance.now() - start;

  return { elapsed };
}

// ━━━ Run all ━━━
console.log("\n=== Benchmark 1: Static-only correlate cycles ===");
console.log("| Events | Cycles | Total (ms) | Per cycle (ms) |");
console.log("|--------|--------|------------|----------------|");
for (const events of [100, 500, 2000]) {
  const r = await benchStaticOnly(events, 50);
  console.log(
    `| ${String(events).padStart(6)} | ${String(50).padStart(6)} | ${r.elapsed.toFixed(0).padStart(10)} | ${r.perCycle.toFixed(2).padStart(14)} |`
  );
}

console.log("\n=== Benchmark 2: Dynamic resolver correlate cycles ===");
console.log("| Events | Cycles | Total (ms) | Per cycle (ms) |");
console.log("|--------|--------|------------|----------------|");
for (const events of [100, 500, 2000]) {
  const r = await benchDynamicCheckpoint(events, 50);
  console.log(
    `| ${String(events).padStart(6)} | ${String(50).padStart(6)} | ${r.elapsed.toFixed(0).padStart(10)} | ${r.perCycle.toFixed(2).padStart(14)} |`
  );
}

console.log("\n=== Benchmark 3: Cold-start first correlate ===");
console.log("| Events | First correlate (ms) |");
console.log("|--------|----------------------|");
for (const events of [100, 500, 2000]) {
  const r = await benchColdStart(events);
  console.log(
    `| ${String(events).padStart(6)} | ${r.elapsed.toFixed(1).padStart(20)} |`
  );
}

await store().dispose();
process.exit(0);
