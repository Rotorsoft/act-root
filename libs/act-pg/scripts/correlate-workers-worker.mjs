/**
 * One worker process for `correlate-workers.bench.mjs` (#1532 / RFC 1484).
 *
 * Runs a real Act against a real Postgres, with `notify: true` so this worker
 * wakes on other processes' commits exactly as a deployed one does. That
 * matters more than it sounds: correlate only scans when armed, and a worker
 * with no local commits and no notify never scans at all. Every previous
 * measurement of correlate ran several Acts inside one process with notify
 * off, so only the process doing the committing ever correlated — which is
 * precisely the redundancy this bench exists to measure.
 *
 * Reports how much of the event log this worker read, split by reader, so the
 * parent can compare total reads against events actually committed.
 */
import pg from "pg";
import { act, state, store as port, ZodEmpty } from "../../act/dist/index.js";
import { z } from "zod";
import { PostgresStore } from "../dist/index.js";

const { SCHEMA, TABLE, WORKER_ID, DEADLINE, CYCLE_MS, PORT } = process.env;
const deadline = Number(DEADLINE);

const Order = state({ Order: z.object({ placed: z.boolean() }) })
  .init(() => ({ placed: false }))
  .emits({ Placed: ZodEmpty })
  .patch({ Placed: () => ({ placed: true }) })
  .on({ place: ZodEmpty })
  .emit(() => ["Placed", {}])
  .build();

const m = {
  correlate_calls: 0,
  correlate_events: 0,
  fetch_calls: 0,
  fetch_events: 0,
  load_calls: 0,
  subscribe_calls: 0,
  subscribe_entries: 0,
  claim_calls: 0,
  leased: 0,
  handled: 0,
};

/** Count reads per caller. The three readers are told apart by query shape. */
const instrumented = (s) =>
  new Proxy(s, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== "function") return value;

      if (prop === "query")
        return (callback, q) => {
          const is_correlate = q?.stream === undefined;
          const is_fetch =
            !is_correlate && q?.after !== undefined && q?.limit !== undefined;
          if (is_correlate) m.correlate_calls++;
          else if (is_fetch) m.fetch_calls++;
          else m.load_calls++;
          return value.call(
            target,
            (event) => {
              if (is_correlate) m.correlate_events++;
              else if (is_fetch) m.fetch_events++;
              return callback(event);
            },
            q
          );
        };

      if (prop === "subscribe")
        return (streams, watermark) => {
          m.subscribe_calls++;
          m.subscribe_entries += streams.length;
          return value.call(target, streams, watermark);
        };

      if (prop === "claim")
        return async (...args) => {
          m.claim_calls++;
          const leases = await value.apply(target, args);
          m.leased += leases.length;
          return leases;
        };

      return (...args) => value.apply(target, args);
    },
  });

const base = new PostgresStore({
  port: Number(PORT),
  schema: SCHEMA,
  table: TABLE,
  notify: true,
  max: 8,
});
// `store()` must be injected before `act()...build()` — the orchestrator wires
// its notify subscription at construction.
port(instrumented(base));

const app = act()
  .withState(Order)
  .on("Placed")
  .do(async function react() {
    m.handled++;
  })
  .to((e) => ({ target: `handled-${e.stream}`, source: e.stream }))
  .build();

const ticker = setInterval(() => {
  app.settle({ debounceMs: 0 });
}, Number(CYCLE_MS));

const started_cpu = process.cpuUsage();
const started_at = Date.now();
await new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())));
clearInterval(ticker);
// Let in-flight settles finish so their reads are counted.
await new Promise((r) => setTimeout(r, 1_500));
await app.shutdown();
const cpu = process.cpuUsage(started_cpu);

await new Promise((resolve) =>
  process.send(
    {
      worker: Number(WORKER_ID),
      ...m,
      wall_ms: Date.now() - started_at,
      cpu_ms: (cpu.user + cpu.system) / 1000,
    },
    resolve
  )
);
process.exit(0);
