/**
 * #1487 — what does always-on correlate cost an app whose reactions are all
 * static? That app used to skip the forward scan entirely (`correlate()` was
 * an early-return); now it scans, because a target correlate never marks is a
 * target `claim` never serves.
 *
 * Two shapes, both driven through the explicit correlate→drain pair on a real
 * PostgresStore (the pair `settle()` loops, but awaitable, so the numbers are
 * deterministic rather than debounce-dependent):
 *
 *   catch-up  — N events already in the log, drained to quiescence. Correlate
 *               pays one scan per pass here.
 *   steady    — commit one event, catch up, repeat. The per-commit cost an
 *               online app actually feels.
 *
 * Run: node libs/act-pg/scripts/static-correlate.bench.mjs
 * Requires Postgres on :5431. Compare against the same script run on the
 * commit before the change — the numbers land in libs/act-pg/PERFORMANCE.md.
 */
import { act, state, store as port, ZodEmpty } from "../../act/dist/index.js";
import { z } from "zod";
import { PostgresStore } from "../dist/index.js";

const SCHEMA = "static_correlate_bench";
const CATCHUP_EVENTS = Number(process.env.EVENTS ?? 5000);
const STEADY_ROUNDS = Number(process.env.ROUNDS ?? 200);
const actor = { id: "bench", name: "bench" };

const Counter = state({ Counter: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Ticked: ZodEmpty })
  .patch({ Ticked: (_e, s) => ({ n: s.n + 1 }) })
  .on({ tick: ZodEmpty })
  .emit(() => ["Ticked", {}])
  .build();

/** Static-only: one reaction, one constant target, no dynamic resolver. */
const build = (handled) =>
  act()
    .withState(Counter)
    .on("Ticked")
    .do(async function project() {
      handled.n++;
    })
    .to({ target: "projection" })
    .build();

/** What `settle` loops, awaited: correlate→drain until a pass does nothing. */
const catch_up = async (app) => {
  let cursor = -1;
  for (;;) {
    const { subscribed, last_id } = await app.correlate({ limit: 100 });
    const drain = await app.drain();
    const progressed =
      subscribed > 0 ||
      drain.acked.length > 0 ||
      drain.blocked.length > 0 ||
      last_id > cursor;
    cursor = last_id;
    if (!progressed) return;
  }
};

// One store for both phases — disposing between them would end the pool the
// second phase needs. Each phase uses its own stream prefix so the shared
// snapshot cache never carries a version across the `drop`+`seed`.
const store = new PostgresStore({ port: 5431, schema: SCHEMA, table: "e" });
port(store);

const main = async () => {
  await store.drop();
  await store.seed();

  // --- catch-up ---------------------------------------------------------
  let handled = { n: 0 };
  let app = build(handled);
  for (let i = 0; i < CATCHUP_EVENTS; i++)
    await app.do("tick", { stream: `a-${i % 50}`, actor }, {});
  const t0 = process.hrtime.bigint();
  await catch_up(app);
  const catchup_ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const catchup_handled = handled.n;
  await app.shutdown();

  // --- steady state -----------------------------------------------------
  handled = { n: 0 };
  app = build(handled);
  // Warm the pipeline (init, static subscribe, first scan) out of the timing.
  await app.do("tick", { stream: "warm", actor }, {});
  await catch_up(app);
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < STEADY_ROUNDS; i++) {
    await app.do("tick", { stream: `b-${i % 50}`, actor }, {});
    await catch_up(app);
  }
  const steady_ms = Number(process.hrtime.bigint() - t1) / 1e6 / STEADY_ROUNDS;
  const steady_handled = handled.n;
  await app.shutdown();
  await store.dispose();

  console.log("static-only app, PostgresStore :5431");
  console.log("");
  console.log("shape    | rounds | latency");
  console.log("---------|--------|--------");
  console.log(
    `catch-up | ${String(CATCHUP_EVENTS).padStart(6)} | ${catchup_ms.toFixed(0).padStart(6)} ms total (${catchup_handled} reactions)`
  );
  console.log(
    `steady   | ${String(STEADY_ROUNDS).padStart(6)} | ${steady_ms.toFixed(2).padStart(6)} ms per commit→catch-up (${steady_handled} reactions)`
  );
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
