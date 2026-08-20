/**
 * One benchmark worker, in its own OS process (#1522).
 *
 * The single-process benchmarks it replaces ran every worker as an async task
 * sharing one event loop and one connection pool, so past ~4 workers the
 * client was plausibly the bottleneck rather than the database — which
 * compresses every measured difference toward 1.0 and makes the numbers lower
 * bounds rather than results.
 *
 * Forked by `hybrid-split.bench.mjs`. Takes its shape from the environment,
 * runs until a deadline, and reports its samples once over IPC. `role`
 * selects what it does:
 *
 *   drain      claim → ack, the competing-consumer loop
 *   marker     stands in for correlate's marking write
 *   committer  the event-log write load
 *
 * Every role reports `cpu`, the process's own CPU time, so client saturation
 * is visible in the output rather than inferred from a suspicious curve.
 */
import { PostgresStore } from "../dist/index.js";

const {
  ROLE: role,
  LOG_PORT,
  SUBS_PORT,
  SCHEMA,
  TABLE,
  STREAMS,
  DEADLINE,
  WORKER_ID,
} = process.env;

const log_port = Number(LOG_PORT);
const subs_port = Number(SUBS_PORT);
const streams = Number(STREAMS);
const deadline = Number(DEADLINE);

/** Each process gets its own pool — the point of the exercise. */
const make = (port) =>
  new PostgresStore({ port, schema: SCHEMA, table: TABLE, max: 8 });

const log = make(log_port);
const subs = log_port === subs_port ? log : make(subs_port);

const timed = async (samples, fn) => {
  const t = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
};

const claim = [];
const ack = [];
const subscribe = [];
const commit = [];
let leased = 0;

async function drain() {
  const by = `w${WORKER_ID}`;
  while (Date.now() < deadline) {
    const leases = await timed(claim, () => subs.claim(8, 2, by, 30_000));
    if (!leases.length) continue;
    leased += leases.length;
    await timed(ack, () =>
      subs.ack(leases.map((l) => ({ ...l, at: l.at + 1 })))
    );
  }
}

async function marker() {
  let cursor = 0;
  while (Date.now() < deadline) {
    const batch = [];
    for (let i = 0; i < 200; i++) {
      const n = (cursor + i) % streams;
      batch.push({
        stream: `s${n}`,
        priority: 0,
        lane: "default",
        correlated_at: 3 * streams + cursor + i,
      });
    }
    cursor = (cursor + 200) % streams;
    await timed(subscribe, () => subs.subscribe(batch, cursor));
  }
}

async function committer() {
  let n = 0;
  while (Date.now() < deadline) {
    await timed(commit, () =>
      // Each committer owns its own streams: shared ones would collide on
      // version and record fast ConcurrencyErrors as though they were commits.
      log.commit(`hot-${WORKER_ID}-${n % 50}`, [{ name: "Opened", data: {} }], {
        correlation: "c",
        causation: {},
      })
    ).catch(() => {});
    n++;
  }
}

const roles = { drain, marker, committer };

const started_cpu = process.cpuUsage();
const started_at = Date.now();
await roles[role]();
const cpu = process.cpuUsage(started_cpu);
// Children are forked at slightly different moments but share one absolute
// deadline, so each one's window is its own. The parent divides by the widest
// of them rather than by the nominal duration, which would overstate every
// rate by however long the slowest fork took to come up.
const wall_ms = Date.now() - started_at;

await log.dispose();
if (subs !== log) await subs.dispose();

// `process.send` is asynchronous and these payloads run to tens of thousands
// of samples, so exiting straight after the call truncates the message and the
// parent sees a clean exit with no report. Wait for the flush callback.
const report = {
  role,
  claim,
  ack,
  subscribe,
  commit,
  leased,
  wall_ms,
  // Microseconds of CPU this process burned. Summed across children and
  // compared with wall-clock × cores, this is what says whether the client
  // ran out of headroom.
  cpu_ms: (cpu.user + cpu.system) / 1000,
};

await new Promise((resolve) => process.send(report, resolve));
process.exit(0);
