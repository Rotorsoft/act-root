import { randomUUID } from "node:crypto";
import {
  type Actor,
  type Committed,
  type Schemas,
  sleep,
  store,
} from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { Chance } from "chance";
import { agentStream } from "./agent.js";
import { agents, db, tickets } from "./drizzle/index.js";
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
  // After the store: bootstrap builds the app as it loads, and a store injected
  // later is ignored.
  const { app } = await import("./bootstrap.js");
  await store().drop();
  await store().seed();

  await db.delete(tickets).execute();
  await db.delete(agents).execute();

  const actor: Actor = { id: randomUUID(), name: "WolfDesk" };
  // Timing automations are deferred reactions (see ticket-timers.ts).
  app.on("acked", async () => {
    const all = await db.select().from(tickets).execute();
    console.table(all);
  });

  // The desk the assign reaction picks from.
  const supportCategoryId = randomUUID();
  const desk = ["Ada", "Ben"].map((name) => ({ id: randomUUID(), name }));
  for (const { id, name } of desk)
    await app.do(
      "AddAgent",
      { stream: agentStream(id), actor },
      { name, supportCategoryId }
    );

  const [t1] = await app.do(
    "OpenTicket",
    { stream: randomUUID(), actor },
    {
      title: chance.name(),
      message: chance.name(),
      productId: randomUUID(),
      priority: chance.pickone([Priority.Low, Priority.Medium, Priority.High]),
      supportCategoryId,
    }
  );

  await rand_sleep(5_000);
  await app.do(
    "AssignTicket",
    { stream: t1.event!.stream, actor },
    {
      agentId: desk[1].id,
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
