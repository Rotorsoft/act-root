import { act, type Committed, type Schemas, store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { randomUUID } from "crypto";
import express from "express";
import { create as pgProjector } from "./pg-projector.js";
import { ConvergenceStatus, updateStats } from "./stats.js";
import { Todo } from "./todo.js";

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

  const projector = pgProjector();
  await projector.init();

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
  const actApp = act()
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

  let drainCount = 0;
  let eventCount = 0;
  let streamCount = 0;
  let convergence: ConvergenceStatus;
  const drainInterval = setInterval(async () => {
    const drain = await actApp.drain({
      streamLimit: 20,
      eventLimit: 200,
    });
    drainCount++;
    convergence = updateStats(drainCount, eventCount, streamCount, drain);
    if (convergence.converged) {
      console.log("\nConverged! Load test complete.");
      drainInterval && clearInterval(drainInterval);
    }
  }, 1000);

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
      streamCount++;
      eventCount++;
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
      eventCount++;
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
      eventCount++;
      res.status(204).send();
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /todos/:stream
  app.get("/todos/:stream", async (req, res) => {
    const todo = await projector.getById(req.params.stream);
    if (!todo) return res.status(404).send();
    res.json(todo);
  });

  // GET /stats (performance summary)
  app.get("/stats", async (_req, res) => {
    const stats = await projector.getStats();
    res.json({
      ...stats,
      ...convergence,
      drainCount,
      eventCount,
      streamCount,
      serialProjection: process.env.SERIAL_PROJECTION === "true",
    });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Sample app listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start app:", err);
  process.exit(1);
});
