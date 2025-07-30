import {
  act,
  type Committed,
  type DrainOptions,
  type Schemas,
  sleep,
} from "@rotorsoft/act";
import { randomUUID } from "crypto";
import { create as memProjector } from "./mem-projector";
import { updateStats } from "./stats";
import { Todo } from "./todo";
import { LoadTestOptions } from "./types";

// serialize projection leases to one key or
// one projection lease per stream?
const projection_resolver =
  process.env.SERIAL_PROJECTION === "true"
    ? () => ({ target: "serial_projection" })
    : (committed: Committed<Schemas, keyof Schemas>) => ({
        target: committed.stream,
        source: committed.stream,
      });

const projector = memProjector();

// Compose the app with state and reactions
export const app = act()
  .with(Todo)
  .on("TodoCreated")
  .do(projector.projectTodoCreated)
  .to(projection_resolver)
  .on("TodoUpdated")
  .do(projector.projectTodoUpdated)
  .to(projection_resolver)
  .on("TodoDeleted")
  .do(projector.projectTodoDeleted)
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

    const lag_drain = await app.drain(lagOptions);
    const lead_drain = await app.drain(leadOptions);
    drainCount++;

    const convergence = updateStats(
      drainCount,
      eventCount,
      streams,
      lag_drain,
      lead_drain
    );

    if (convergence.bothConverged && drainInterval) {
      clearInterval(drainInterval);
      drainInterval = undefined;

      console.log("\nBoth strategies have converged! Load test complete.");
      const stats = await projector.getStats();
      console.table({
        ...stats,
        lagConvergenceTime: `${convergence.lagConvergedTime! / 1000} seconds`,
        leadConvergenceTime: `${convergence.leadConvergedTime! / 1000} seconds`,
      });
    }
  }
}

async function main(
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
      await app.correlate({
        stream,
        after: snap.event!.id - 1,
      });
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

void main({
  maxEvents: 350,
  createMax: 200,
  eventFrequency: 10,
  drainFrequency: 500,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
