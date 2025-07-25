import { Actor, Committed, Schemas, sleep, store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { Chance } from "chance";
import { randomUUID } from "crypto";
import { app } from "./bootstrap.js";
import { db, tickets } from "./drizzle/index.js";
import { start_jobs } from "./jobs.js";
import { Priority } from "./schemas/index.js";

const chance = new Chance();
const rand_sleep = (max = 10_000) => sleep(chance.integer({ min: 100, max }));

async function main() {
  // to use pg, run `docker-compose up -d`
  store(
    new PostgresStore({
      port: 5431,
      schema: "act",
      table: "wolfdesk",
    })
  );
  await store().drop();
  await store().seed();

  await db.delete(tickets).execute();

  const actor: Actor = { id: randomUUID(), name: "WolfDesk" };
  start_jobs();
  app.on("acked", async () => {
    const all = await db.select().from(tickets).execute();
    console.table(all);
  });
  app.on("committed", () => {
    void app.drain();
  });
  app.start_correlations({ after: 0, limit: 10 }, 3000);

  const [t1] = await app.do(
    "OpenTicket",
    { stream: randomUUID(), actor },
    {
      title: chance.name(),
      message: chance.name(),
      productId: randomUUID(),
      priority: chance.pickone([Priority.Low, Priority.Medium, Priority.High]),
      supportCategoryId: randomUUID(),
    }
  );

  await rand_sleep(5_000);
  await app.do(
    "AssignTicket",
    { stream: t1.event!.stream, actor },
    {
      agentId: randomUUID(),
      reassignAfter: new Date(),
      escalateAfter: new Date(),
    }
  );

  await rand_sleep(5_000);
  await app.do(
    "AddMessage",
    { stream: t1.event!.stream, actor },
    {
      body: chance.name(),
      to: t1.state.userId,
      attachments: {},
    }
  );

  await rand_sleep(15_000);
  await app.do(
    "AddMessage",
    { stream: t1.event!.stream, actor },
    {
      body: chance.name(),
      to: t1.state.userId,
      attachments: {},
    }
  );

  await rand_sleep(10_000);
  // show t1 correlated events
  const correlated = {} as Record<string, Committed<Schemas, keyof Schemas>[]>;
  await app.query(
    {
      stream: t1.event!.stream,
    },
    (e) => {
      if (!correlated[e.meta.correlation]) {
        correlated[e.meta.correlation] = [];
      }
      correlated[e.meta.correlation].push(e);
    }
  );
  Object.entries(correlated).forEach(([correlation, events]) => {
    console.log(`=== ${correlation} ===`);
    console.log(
      events
        .map(
          ({ id, name, meta }, index) =>
            `${" ".repeat(index * 3)}${id}: ${name}${meta.causation.action ? ` (${meta.causation.action.name} by ${meta.causation.action.actor.name})` : ""}${meta.causation.event?.id ? ` <- ${meta.causation.event.id}` : ""}`
        )
        .join("\n")
    );
  });
}

void main();
