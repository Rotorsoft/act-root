import { act, store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { randomUUID } from "crypto";
import express from "express";
import {
  getAll,
  getById,
  initProjection,
  metrics,
  projectTodoCreated,
  projectTodoDeleted,
  projectTodoUpdated,
} from "./projection";
import { Todo } from "./todo.model";

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
  await store().seed();
  await initProjection();

  // Compose the app with state and reactions
  const actApp = act()
    .with(Todo)
    .on("TodoCreated")
    .do(projectTodoCreated)
    .on("TodoUpdated")
    .do(projectTodoUpdated)
    .on("TodoDeleted")
    .do(projectTodoDeleted)
    .build();

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
      await actApp.do(
        "create",
        {
          stream,
          actor: { id: actorId, name: actorId },
        },
        { text: req.body.text }
      );
      await actApp.drain();
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
      await actApp.drain();
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
      await actApp.drain();
      res.status(204).send();
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /todos/:stream
  app.get("/todos/:stream", async (req, res) => {
    const todo = await getById(req.params.stream);
    if (!todo) return res.status(404).send();
    res.json(todo);
  });

  // GET /todos
  app.get("/todos", async (_req, res) => {
    const todos = await getAll();
    res.json(todos);
  });

  // GET /metrics (for reaction throughput)
  app.get("/metrics", (_req, res) => {
    const m = metrics();
    res.json(m);
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Sample app listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start app:", err);
  process.exit(1);
});
