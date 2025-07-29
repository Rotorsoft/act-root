import { store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { randomUUID } from "crypto";
import express from "express";
import { app as actApp, drain, loadTest } from "./load-test.js";
import {
  getAll,
  getById,
  getEventsStats,
  getTodosStats,
  initProjection,
} from "./projection.js";

const PORT = Number(process.env.PORT) || 3000;

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
    await drain();
    res.status(200).send();
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Sample app listening on port ${PORT}`);
  });
}

main()
  .then(() => {
    if (process.env.SIMULATE_LOAD)
      void loadTest({
        maxEvents: 350,
        createMax: 200,
        eventFrequency: 10,
        drainFrequency: 500,
      });
  })
  .catch((err) => {
    console.error("Failed to start app:", err);
    process.exit(1);
  });
