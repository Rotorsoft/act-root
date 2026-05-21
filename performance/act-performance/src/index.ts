import { randomUUID } from "node:crypto";
import {
  act,
  type Committed,
  type Drain,
  type Schemas,
  sleep,
  store,
} from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { create as memProjector } from "./mem-projector";
import { create as pgProjector } from "./pg-projector";
import { updateStats } from "./stats";
import { Todo } from "./todo";
import type { LoadTestOptions } from "./types";

// maps a todo-UUID stream to a bucket of N+1 streams
function target(stream: string, N: number) {
  const first = parseInt(stream[5], 16); // first uuid character
  return first % N;
}

// Three-lane split. Each event type drains on *its own* set of target
// streams, on its own lane, with its own lease budget. Keeping the
// target streams disjoint per lane is load-bearing: `subscribe()`
// UPSERTs the lane every call, so if all three event types resolved
// to the same `stream-X`, the lane field would be overwritten on
// each subscribe and only the last writer's lane would actually hold
// — the other two lanes would end up with zero streams assigned.
//
// Naming convention: `<lane>-<bucket>` (e.g. `creates-0`, `updates-3`,
// `deletes-7`). 25 buckets per lane via UUID hash.
const LANES = ["creates", "updates", "deletes"] as const;
type Lane = (typeof LANES)[number];
const lane_for = (eventName: string): Lane => {
  if (eventName === "TodoCreated") return "creates";
  if (eventName === "TodoDeleted") return "deletes";
  return "updates";
};

const resolveTarget = (committed: Committed<Schemas, keyof Schemas>) => {
  const lane = lane_for(String(committed.name));
  return {
    target:
      process.env.SERIAL_PROJECTION === "true"
        ? `${lane}-serial`
        : `${lane}-${target(committed.stream, 25)}`,
    source: "todo.*",
    lane,
  };
};

// Lane-shaped artificial latency. Tuned to make the contrast obvious
// in the rendered table — creates run at full speed; updates pay a
// small tax; the slow lane (deletes) pays enough that an operator
// watching the table sees its frontier lag behind creates and
// updates have already settled.
const LANE_DELAY_MS: Record<Lane, number> = {
  creates: 0,
  updates: 25,
  deletes: 150,
};

// Wrap a projector callback with the lane-specific delay. Returns a
// *named* function — Act's `.do()` rejects anonymous handlers because
// the name shows up in traces.
function withDelay<H extends (...args: never[]) => Promise<unknown>>(
  name: string,
  lane: Lane,
  handler: H
): H {
  const delay = LANE_DELAY_MS[lane];
  const wrapped = {
    async [name](...args: Parameters<H>) {
      if (delay > 0) await sleep(delay);
      return handler(...args);
    },
  }[name];
  return wrapped as H;
}

// Don't use PG option in browser
const usePg = process.env.USE_PG === "true";
if (usePg) {
  store(
    new PostgresStore({
      host: "localhost",
      port: 5431,
      user: "postgres",
      password: "postgres",
      database: "postgres",
      schema: "performance",
    })
  );
}
const projector = usePg
  ? pgProjector("postgres://postgres:postgres@localhost:5431/postgres")
  : memProjector();

// Composed "Todo" app — three lanes give each event type its own
// lease budget so the per-cycle table shows three independent
// leading/lagging frontiers converging at different rates.
export const app = act()
  .withState(Todo)
  .withLane({ name: "creates", leaseMillis: 2_000, streamLimit: 20 })
  .withLane({ name: "updates", leaseMillis: 5_000, streamLimit: 15 })
  .withLane({ name: "deletes", leaseMillis: 30_000, streamLimit: 5 })
  .on("TodoCreated")
  .do(withDelay("projectTodoCreated", "creates", projector.projectTodoCreated))
  .to(resolveTarget)
  .on("TodoUpdated")
  .do(withDelay("projectTodoUpdated", "updates", projector.projectTodoUpdated))
  .to(resolveTarget)
  .on("TodoDeleted")
  .do(withDelay("projectTodoDeleted", "deletes", projector.projectTodoDeleted))
  .to(resolveTarget)
  .build();

// === Observability via lifecycle events ===
//
// Best-practice Act apps don't poll for drain results — the framework
// emits lifecycle events as work happens, and listeners read those.
// Two channels feed the dashboard:
//
//   `committed` — increments the "committed" headline counter.
//   `acked`     — appended to a recent-acks ring; the render timer
//                 below snapshots and clears the ring each tick to
//                 build the per-cycle table.
//   `blocked`   — surfaced as a warning line.
//
// The orchestrator auto-schedules a settle pass on every commit, so
// there's no manual `setInterval(drain)` driving work — load just
// commits and the framework drives the drain to completion. The
// `setInterval` below is *render only*: it doesn't trigger drain, it
// just paints accumulated lifecycle data.
//
// (Why not the `settled` event? Settle is debounced + loops to
// completion per pass, so under sustained load it fires once at the
// very end. That'd give us one final table, not a running view.
// Rendering off `acked` decouples display cadence from drain cadence.)
import type { BlockedLease, Lease } from "@rotorsoft/act";

let totalCommitted = 0;
let renderCount = 0;
let loadFinished = false;
const ackedSinceLastRender: Lease[] = [];
const blockedSeen: BlockedLease[] = [];

app.on("committed", (snapshots) => {
  totalCommitted += snapshots.length;
});

app.on("acked", (acked) => {
  ackedSinceLastRender.push(...acked);
});

app.on("blocked", (blocked) => {
  blockedSeen.push(...blocked);
  for (const b of blocked) console.error(`⚠ blocked: ${b.stream} ${b.error}`);
});

/**
 * Wait until the orchestrator has nothing left to drain.
 *
 * Listens for a `settled` event whose `acked` + `leased` are both
 * empty — that's the operational definition of "fully caught up".
 * Schedules an immediate settle pass to kick things in case nothing
 * recent has fired one.
 *
 * Returns true when settlement was observed; false on timeout.
 */
function waitForCaughtUp(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      app.off("settled", onSettled);
      resolve(false);
    }, timeoutMs);
    const onSettled = (drain: Drain<Schemas>) => {
      if (drain.acked.length === 0 && drain.leased.length === 0) {
        clearTimeout(timer);
        app.off("settled", onSettled);
        resolve(true);
      }
    };
    app.on("settled", onSettled);
    app.settle({ debounceMs: 0 });
  });
}

async function main(
  { maxEvents, createMax, eventFrequency }: LoadTestOptions = {
    maxEvents: 300,
    createMax: 200,
    eventFrequency: 100,
  }
) {
  await store().drop();
  await store().seed();
  await projector.init();

  // Render the dashboard at a steady cadence, snapshotting whatever
  // lifecycle events have accumulated since the last paint. This is
  // separate from drain — Act runs that internally on every commit.
  const renderTimer = setInterval(() => {
    renderCount++;
    const acked = ackedSinceLastRender.splice(0);
    // Synthesize a minimal Drain-shaped payload from the accumulated
    // acks. updateStats only reads `acked`, `leased`, `fetched`, so
    // empty arrays for the latter two are fine — they'd be the same
    // from the framework's perspective at the moment we render.
    const drainSnapshot = {
      acked,
      leased: [],
      fetched: [],
      blocked: blockedSeen,
    };
    updateStats(
      renderCount,
      totalCommitted,
      drainSnapshot,
      LANES,
      loadFinished
    );
  }, 500);

  const actorId = "local";
  const streams = new Set<string>();
  let eventCount = 0;
  const startTime = Date.now();

  while (eventCount < maxEvents) {
    eventCount++;
    await sleep(eventFrequency);
    const op = Math.random();
    if (eventCount < createMax && (op < 0.4 || streams.size === 0)) {
      const stream = "todo-" + randomUUID();
      await app.do(
        "create",
        { stream, actor: { id: actorId, name: actorId } },
        { text: "created @ " + new Date().toISOString() }
      );
      streams.add(stream);
    } else if (op < 0.8 && streams.size > 0) {
      const idx = Math.floor(Math.random() * streams.size);
      const stream = [...streams.keys()][idx];
      await app.do(
        "update",
        { stream, actor: { id: actorId, name: actorId } },
        { text: "updated @ " + new Date().toISOString() }
      );
    } else if (streams.size > 0) {
      const idx = Math.floor(Math.random() * streams.size);
      const stream = [...streams.keys()][idx];
      await app.do(
        "delete",
        { stream, actor: { id: actorId, name: actorId } },
        {}
      );
      streams.delete(stream);
    }
  }
  loadFinished = true;

  console.log("\nLoad complete. Waiting for drain to catch up…");
  const caughtUp = await waitForCaughtUp(120_000);
  clearInterval(renderTimer);
  if (!caughtUp) {
    console.error("Timed out waiting for drain to settle.");
    process.exit(1);
  }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(
    `\n✓ Converged after ${renderCount} render cycles, ${elapsed.toFixed(2)}s.`
  );
  console.table({
    ...(await projector.getStats()),
    committed: totalCommitted,
    blocked: blockedSeen.length,
    durationSec: elapsed.toFixed(2),
  });
  process.exit(0);
}

// 👉 Change app options to evaluate performance at different load levels
void main({
  maxEvents: 350,
  createMax: 200,
  eventFrequency: 10,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
