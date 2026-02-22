import {
  act,
  type Committed,
  type Schemas,
  sleep,
  store,
} from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { randomUUID } from "crypto";
import { create as memProjector } from "./mem-projector";
import { create as pgProjector } from "./pg-projector";
import { updateStats } from "./stats";
import { Todo } from "./todo";
import { LoadTestOptions } from "./types";

// maps a todo-UUID stream to a bucket of N+1 streams
function target(stream: string, N: number) {
  const first = parseInt(stream[5], 16); // first uuid character
  return first % N;
}

// serialize projection leases to one key or
// one projection lease per stream?
const projection_resolver =
  process.env.SERIAL_PROJECTION === "true"
    ? // serial projection (only one projection stream)
      () => ({ target: "serial_projection" })
    : // parallel projection (custom resolver to N projection streams)
      (committed: Committed<Schemas, keyof Schemas>) => ({
        target: `stream-${target(committed.stream, 25)}`, // use N > streamLimit to avoid conflicts
        source: "todo.*", // incluce all todos
      });
// // parallel projection (default resolver is one-stream-to-one-projection)
// : (committed: Committed<Schemas, keyof Schemas>) => ({
//   target: committed.stream,
//   source: committed.stream,
// });

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

// Composed "Todo" app with state and reactions
export const app = act()
  .withState(Todo)
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
let drainInterval: ReturnType<typeof setInterval> | undefined = undefined;
let lastDrain = Date.now();
let eventCount = 0;
let drainCount = 0;
const streams = new Set<string>();

/**
 * Debounced drain for convergence testing.
 *
 * Drains the store every FREQ ms.
 *
 * Logs the lag and lead of the drain.
 */
export async function drain() {
  const now = Date.now();
  if (now - lastDrain > drainFrequency) {
    lastDrain = now;

    const drain = await app.drain(drainOptions);
    drainCount++;

    const [lagging, leading] = updateStats(drainCount, eventCount, drain);

    if (lagging.convergedAt && leading.convergedAt) {
      clearInterval(drainInterval);
      drainInterval = undefined;

      console.log("\nConverged! Load test complete.");
      const stats = await projector.getStats();
      console.table({
        ...stats,
        lagging: `Converged @${lagging.convergedAt} in ${lagging.convergedTime! / 1000} seconds`,
        leading: `Converged @${leading.convergedAt} in ${leading.convergedTime! / 1000} seconds`,
      });
    }
  }
}

// Main event generation loop
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

  drainInterval = setInterval(drain, drainFrequency);
  // app.on("committed", debouncedDrain);

  const actorId = "local";
  while (eventCount < maxEvents) {
    eventCount++;
    await sleep(eventFrequency);
    const op = Math.random();
    if (eventCount < createMax && (op < 0.5 || streams.size === 0)) {
      const stream = "todo-" + randomUUID();
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

// 👉 Change drain options to evaluate performance at different load levels
const drainFrequency = 500;
const drainOptions = {
  streamLimit: 15,
  eventLimit: 20,
};
// 👉 Change app options to evaluate performance at different load levels
void main({
  maxEvents: 350,
  createMax: 200,
  eventFrequency: 10,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
