/**
 * #1524 — are the two remaining correlate caches worth building?
 *
 * Both were planned before anything was measured, and the measurements moved
 * underneath them. This does not implement either. It measures the ceiling on
 * what each could save, so the decision is made on a number.
 *
 *   item 3   skip a mark this worker already sent. Several workers correlate
 *            the same range of the log and send the same `correlated_at` for
 *            the same target. The store applies GREATEST, so the duplicates
 *            are harmless — but they are still round trips. The ceiling is the
 *            fraction of subscribed entries that raise nothing.
 *
 *   item 4   cache the event window. Events are immutable, so a window of them
 *            by id range is valid forever. Correlate scans a range, and the
 *            drain then fetches overlapping ranges of the same events in the
 *            same process. The ceiling is the fraction of event reads that are
 *            re-reads of something already seen.
 *
 * No benchmark exercised correlate's read path before this one — every earlier
 * measurement was claim/ack/subscribe — so item 4 had no evidence either way.
 *
 * The shape is the deployment shape: W Act instances sharing one store, each
 * with its own correlate checkpoint and its own settle loop, plus a writer
 * committing throughout. Duplicates between workers only exist because the
 * workers are real.
 *
 * Run:
 *   docker compose up -d
 *   pnpm build
 *   LOG_LEVEL=error node libs/act-pg/scripts/correlate-reads.bench.mjs
 */
import pg from "pg";
import { act, state, store as port, ZodEmpty } from "../../act/dist/index.js";
import { z } from "zod";
import { PostgresStore } from "../dist/index.js";

const SCHEMA = "correlate_reads_bench";
const TABLE = "events";
const WORKERS = Number(process.env.WORKERS ?? 4);
const SECONDS = Number(process.env.SECONDS ?? 30);
const COMMITS_PER_SEC = Number(process.env.COMMITS_PER_SEC ?? 20);
const AGGREGATES = Number(process.env.AGGREGATES ?? 500);
const CYCLE_MS = Number(process.env.CYCLE_MS ?? 100);

const actor = { id: "bench", name: "bench" };

const Order = state({ Order: z.object({ placed: z.boolean() }) })
  .init(() => ({ placed: false }))
  .emits({ Placed: ZodEmpty })
  .patch({ Placed: () => ({ placed: true }) })
  .on({ place: ZodEmpty })
  .emit(() => ["Placed", {}])
  .build();

const pool = new pg.Pool({
  host: "localhost",
  port: 5431,
  user: "postgres",
  password: "postgres",
  max: 16,
});

const m = {
  // Correlate's scan: query() with no stream filter.
  correlate_calls: 0,
  correlate_events: 0,
  correlate_ids: new Set(),
  // The drain's per-stream fetch: query() with a stream filter.
  fetch_calls: 0,
  fetch_events: 0,
  fetch_ids: new Set(),
  // Fetches that came back with nothing. Since #1488 `claim` only hands out a
  // stream when `at < correlated_at`, so an empty fetch means the drain was
  // told there was work and found none — a wasted round trip a cache would
  // hide rather than fix.
  fetch_empty: 0,
  correlate_empty: 0,
  load_calls: 0,
  load_events: 0,
  load_empty: 0,
  // Every event id read by either path, however many times.
  all_reads: 0,
  distinct_ids: new Set(),
  // subscribe() entries, and the ones carrying a mark that raises nothing.
  sub_calls: 0,
  sub_entries: 0,
  sub_marks: 0,
  sub_noop_marks: 0,
};

/**
 * Wrap the store to count reads and no-op marks.
 *
 * The `subscribe` wrapper does an extra read to learn what each row already
 * held, which perturbs timing — this bench reports counts, never latency.
 */
const instrumented = (s) =>
  new Proxy(s, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== "function") return value;

      if (prop === "query")
        return (callback, q) => {
          // Three distinct readers share `query`, and telling them apart is
          // the whole point — an earlier version of this bench counted every
          // stream-filtered read as a drain fetch and silently folded the
          // aggregate loads from `do()` into that column.
          //   correlate scan  no stream filter
          //   drain fetch     stream + after + limit (a windowed read)
          //   aggregate load  stream only, no bounds (replay from 0)
          const is_correlate = q?.stream === undefined;
          const is_fetch =
            !is_correlate && q?.after !== undefined && q?.limit !== undefined;
          if (is_correlate) m.correlate_calls++;
          else if (is_fetch) m.fetch_calls++;
          else m.load_calls++;
          let seen = 0;
          const done = () => {
            if (seen === 0) {
              if (is_correlate) m.correlate_empty++;
              else if (is_fetch) m.fetch_empty++;
              else m.load_empty++;
            }
          };
          const out = value.call(
            target,
            (event) => {
              seen++;
              m.all_reads++;
              m.distinct_ids.add(event.id);
              if (is_correlate) {
                m.correlate_events++;
                m.correlate_ids.add(event.id);
              } else if (is_fetch) {
                m.fetch_events++;
                m.fetch_ids.add(event.id);
              } else m.load_events++;
              return callback(event);
            },
            q
          );
          return Promise.resolve(out).then((r) => {
            done();
            return r;
          });
        };

      if (prop === "subscribe")
        return async (streams, watermark) => {
          m.sub_calls++;
          m.sub_entries += streams.length;
          const marked = streams.filter((e) => e.correlated_at !== undefined);
          m.sub_marks += marked.length;
          if (marked.length) {
            const { rows } = await pool.query(
              `SELECT stream, correlated_at FROM ${SCHEMA}.${TABLE}_streams
                WHERE stream = ANY($1::text[])`,
              [marked.map((e) => e.stream)]
            );
            const held = new Map(
              rows.map((r) => [r.stream, Number(r.correlated_at)])
            );
            for (const e of marked) {
              const current = held.get(e.stream);
              // A mark that does not exceed what the row already holds is a
              // round trip that changes nothing — exactly what item 3 would
              // elide locally.
              if (current !== undefined && e.correlated_at <= current)
                m.sub_noop_marks++;
            }
          }
          return value.call(target, streams, watermark);
        };

      return (...args) => value.apply(target, args);
    },
  });

const pctf = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) : "0.0");

async function main() {
  console.log(
    `Correlate reads — ${WORKERS} worker Acts, ${COMMITS_PER_SEC} commits/s, ` +
      `${AGGREGATES} aggregates, ${SECONDS}s\n`
  );

  const base = new PostgresStore({
    port: 5431,
    schema: SCHEMA,
    table: TABLE,
    max: 16,
  });
  await base.drop();
  await base.seed();
  port(instrumented(base));

  const workers = [];
  for (let w = 0; w < WORKERS; w++) {
    workers.push(
      act()
        .withState(Order)
        .on("Placed")
        .do(async function react() {})
        .to((e) => ({ target: `handled-${e.stream}`, source: e.stream }))
        .build()
    );
  }
  const writer = workers[0];

  const deadline = Date.now() + SECONDS * 1000;
  const tickers = workers.map((app) =>
    setInterval(() => {
      app.settle({ debounceMs: 0 });
    }, CYCLE_MS)
  );

  let n = 0;
  const gap = 1000 / COMMITS_PER_SEC;
  while (Date.now() < deadline) {
    await writer
      .do("place", { stream: `order-${n % AGGREGATES}`, actor }, {})
      .catch(() => {});
    n++;
    await new Promise((r) => setTimeout(r, gap));
  }

  for (const t of tickers) clearInterval(t);
  // Let in-flight settles finish so their reads are counted.
  await new Promise((r) => setTimeout(r, 2_000));
  for (const app of workers) await app.shutdown();

  const overlap = [...m.fetch_ids].filter((id) =>
    m.correlate_ids.has(id)
  ).length;
  const repeat = m.all_reads - m.distinct_ids.size;

  console.log(`  events committed:            ${n}`);
  console.log("");
  console.log("  item 4 — cache the event window");
  console.log(
    `    correlate scan:            ${m.correlate_calls} calls, ${m.correlate_events} events read`
  );
  console.log(
    `    drain fetch:               ${m.fetch_calls} calls, ${m.fetch_events} events read`
  );
  console.log(
    `    fetches returning nothing: ${m.fetch_empty} (${pctf(m.fetch_empty, m.fetch_calls)}% of fetches)`
  );
  console.log(
    `    scans returning nothing:   ${m.correlate_empty} (${pctf(m.correlate_empty, m.correlate_calls)}% of scans)`
  );
  console.log(
    `    total event reads:         ${m.all_reads} (${m.distinct_ids.size} distinct)`
  );
  console.log(
    `    re-reads:                  ${repeat} (${pctf(repeat, m.all_reads)}% of reads)`
  );
  console.log(
    `    read by both paths:        ${overlap} ids (${pctf(overlap, m.distinct_ids.size)}% of distinct)`
  );
  console.log(
    `    aggregate loads:           ${m.load_calls} calls, ${m.load_events} events read (${m.load_empty} empty)`
  );
  console.log("");
  console.log("  item 3 — skip an already-sent mark");
  console.log(
    `    subscribe calls:           ${m.sub_calls} (${m.sub_entries} entries)`
  );
  console.log(
    `    entries carrying a mark:   ${m.sub_marks} (${pctf(m.sub_marks, m.sub_entries)}% of entries)`
  );
  console.log(
    `    marks that raised nothing: ${m.sub_noop_marks} (${pctf(m.sub_noop_marks, m.sub_marks)}% of marks)`
  );

  await base.dispose();
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
