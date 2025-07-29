import {
  act,
  DrainOptions,
  sleep,
  type Committed,
  type Schemas,
} from "@rotorsoft/act";
import { randomUUID } from "crypto";
import {
  getEventsStats,
  getTodosStats,
  projectTodoCreated,
  projectTodoDeleted,
  projectTodoUpdated,
} from "./projection";
import { updateStats } from "./stats";
import { Todo } from "./todo";

// serialize projection leases to one key or
// one projection lease per stream?
const projection_resolver =
  process.env.SERIAL_PROJECTION === "true"
    ? () => ({ target: "serial_projection" })
    : (committed: Committed<Schemas, keyof Schemas>) => ({
        target: committed.stream,
        source: committed.stream,
      });

// Compose the app with state and reactions
export const app = act()
  .with(Todo)
  .on("TodoCreated")
  .do(projectTodoCreated)
  .to(projection_resolver)
  .on("TodoUpdated")
  .do(projectTodoUpdated)
  .to(projection_resolver)
  .on("TodoDeleted")
  .do(projectTodoDeleted)
  .to(projection_resolver)
  .build(100);

// load test variables
let debounceFrequency = 1000;
let drainInterval: ReturnType<typeof setInterval> | undefined = undefined;
let lastDrain = Date.now();
let eventCount = 0;
let drainCount = 0;
const streams = new Set<string>();

const lagOptions: DrainOptions = {
  streamLimit: 10,
  eventLimit: 200,
};

const leadOptions: DrainOptions = {
  streamLimit: 5,
  eventLimit: 5,
  descending: true,
};

type LoadTestOptions = {
  maxEvents: number;
  createMax: number;
  eventFrequency: number;
  drainFrequency: number;
};

/**
 * Debounced drain for convergence testing.
 *
 * Drains the store every FREQ ms.
 *
 * Logs the lag and lead of the drain.
 */
export async function drain() {
  const now = Date.now();
  if (now - lastDrain > debounceFrequency) {
    lastDrain = now;

    const lag_drained = await app.drain(lagOptions);
    const lead_drained = await app.drain(leadOptions);

    const lag = lag_drained.acked
      .map((acked, index) => ({
        at: acked.at,
        incomplete: lag_drained.leased[index]?.at > acked.at,
      }))
      .sort((a, b) => a.at - b.at);

    const lead = lead_drained.acked
      .map((acked, index) => ({
        at: acked.at,
        incomplete: lead_drained.leased[index]?.at > acked.at,
      }))
      .sort((a, b) => a.at - b.at);

    drainCount++;
    const convergence = updateStats(drainCount, eventCount, streams, lag, lead);

    if (convergence.bothConverged && drainInterval) {
      clearInterval(drainInterval);
      drainInterval = undefined;

      console.log("\nBoth strategies have converged! Load test complete.");
      const [todosStats, eventsStats] = await Promise.all([
        getTodosStats(),
        getEventsStats(),
      ]);
      const finalStats = {
        lastEventInStore: eventsStats.lastEventInStore,
        lastProjectedEvent: eventsStats.lastProjectedEvent,
        totalTodos: todosStats.totalTodos,
        activeTodos: todosStats.activeTodos,
        lagConvergenceTime: `${convergence.lagConvergedTime! / 1000} seconds`,
        leadConvergenceTime: `${convergence.leadConvergedTime! / 1000} seconds`,
      };
      console.table(finalStats);
    }
  }
}

export async function loadTest(
  { maxEvents, createMax, eventFrequency, drainFrequency }: LoadTestOptions = {
    maxEvents: 300,
    createMax: 200,
    eventFrequency: 100,
    drainFrequency: 1000,
  }
) {
  debounceFrequency = drainFrequency;
  drainInterval = setInterval(drain, drainFrequency);
  // app.on("committed", debouncedDrain);

  const actorId = "local";
  while (eventCount < maxEvents) {
    eventCount++;
    await sleep(eventFrequency);
    const op = Math.random();
    if (eventCount < createMax && (op < 0.5 || streams.size === 0)) {
      const stream = randomUUID();
      const [snap] = await app.do(
        "create",
        { stream, actor: { id: actorId, name: actorId } },
        { text: "created @ " + new Date().toISOString() }
      );
      // correlate right after creation
      await app.correlate({ stream, after: snap.event!.id - 1 });
      streams.add(stream);
    } else if (op <= 0.95 && streams.size > 0) {
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
}
