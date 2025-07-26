import { act, store, type Committed, type Schemas } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { randomUUID } from "crypto";
import express from "express";
import {
  getAll,
  getById,
  getEventsStats,
  getTodosStats,
  initProjection,
  projectTodoCreated,
  projectTodoDeleted,
  projectTodoUpdated,
} from "./projection.js";
import { Todo } from "./todo.js";

const PORT = Number(process.env.PORT) || 3000;

// serialize projection leases to one key or
// one projection lease per stream?
const projection_resolver =
  process.env.SERIAL_PROJECTION === "true"
    ? () => ({ target: "serial_projection" })
    : (committed: Committed<Schemas, keyof Schemas>) => ({
        target: committed.stream,
        source: committed.stream,
      });

async function main() {
  store(
    new PostgresStore({
      host: process.env.PG_HOST || "localhost",
      port: +(process.env.PG_PORT || "5431"),
      user: "postgres",
      password: "postgres",
      database: "postgres",
      schema: "performance",
    })
  );
  await store().drop();
  await store().seed();
  await initProjection();

  // Compose the app with state and reactions
  const actApp = act()
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

  // Debounced drain on commits or scheduled interval
  let lastDrain = Date.now();
  async function debouncedDrain() {
    const now = Date.now();
    if (now - lastDrain > 1000) {
      lastDrain = now;
      const drained = await actApp.drain({
        streamLimit: 100,
        eventLimit: 100,
      });
      console.log(drained);
    }
  }
  setInterval(debouncedDrain, 3000);
  actApp.on("committed", debouncedDrain);

  // Start Express API
  const app = express();
  app.use(express.json());

  // POST /todos
  app.post("/todos", async (req, res) => {
    try {
      const actorId = req.headers["authorization"]
        ? req.headers["authorization"].replace("Bearer ", "")
        : "system";
      const stream = randomUUID();
      const [snap] = await actApp.do(
        "create",
        {
          stream,
          actor: { id: actorId, name: actorId },
        },
        { text: req.body.text }
      );
      // correlate right after creation
      await actApp.correlate({ stream, after: snap.event!.id - 1 });
      res.status(201).json({ stream });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // PUT /todos/:stream
  app.put("/todos/:stream", async (req, res) => {
    try {
      const actorId = req.headers["authorization"]
        ? req.headers["authorization"].replace("Bearer ", "")
        : "system";
      await actApp.do(
        "update",
        { stream: req.params.stream, actor: { id: actorId, name: actorId } },
        { text: req.body.text }
      );
      res.status(200).json({ stream: req.params.stream });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // DELETE /todos/:stream
  app.delete("/todos/:stream", async (req, res) => {
    try {
      const actorId = req.headers["authorization"]
        ? req.headers["authorization"].replace("Bearer ", "")
        : "system";
      await actApp.do(
        "delete",
        { stream: req.params.stream, actor: { id: actorId, name: actorId } },
        {}
      );
      res.status(204).send();
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /todos
  app.get("/todos", async (_req, res) => {
    const todos = await getAll();
    res.json(todos);
  });

  // GET /todos/:stream
  app.get("/todos/:stream", async (req, res) => {
    const todo = await getById(req.params.stream);
    if (!todo) return res.status(404).send();
    res.json(todo);
  });

  // GET /stats (performance summary)
  app.get("/stats", async (_req, res) => {
    const [todosStats, eventsStats] = await Promise.all([
      getTodosStats(),
      getEventsStats(),
    ]);
    res.json({
      lastEventInStore: eventsStats.lastEventInStore,
      lastProjectedEvent: eventsStats.lastProjectedEvent,
      totalTodos: todosStats.totalTodos,
      activeTodos: todosStats.activeTodos,
      serialProjection: process.env.SERIAL_PROJECTION === "true",
    });
  });

  // POST /drain (debounced drain for convergence testing)
  app.post("/drain", async (_req, res) => {
    await debouncedDrain();
    res.status(200).send();
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Sample app listening on port ${PORT}`);
  });

  return actApp;
}

main()
  .then((actApp) => {
    console.log("App started");

    // simulate load when in local dev mode
    if (process.env.SIMULATE_LOAD)
      setInterval(async () => {
        const actorId = randomUUID();
        const stream = randomUUID();
        const [snap] = await actApp.do(
          "create",
          { stream, actor: { id: actorId, name: actorId } },
          {
            text: randomUUID(),
          }
        );
        // correlate right after creation
        await actApp.correlate({ stream, after: snap.event!.id - 1 });
        await actApp.do(
          "update",
          { stream, actor: { id: actorId, name: actorId } },
          {
            text: randomUUID(),
          }
        );
      }, 1000);
  })
  .catch((err) => {
    console.error("Failed to start app:", err);
    process.exit(1);
  });
