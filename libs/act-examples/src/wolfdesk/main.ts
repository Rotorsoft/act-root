import { Actor, Committed, Schemas, sleep, store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { Chance } from "chance";
import { randomUUID } from "crypto";
import { db, tickets } from "../drizzle";
import { act, Priority } from "./bootstrap";
import { start_jobs } from "./jobs";

const chance = new Chance();
const rand_sleep = (max = 10_000) => sleep(chance.integer({ min: 100, max }));

async function main() {
  // to use pg, run `docker-compose up -d`
  store(new PostgresStore("wolfdesk"));
  await store().drop();
  await store().seed();

  await db.delete(tickets).execute();

  const actor: Actor = { id: randomUUID(), name: "WolfDesk" };
  start_jobs();
  act.on("drained", async () => {
    const all = await db.select().from(tickets).execute();
    console.table(all);
  });
  act.on("committed", () => {
    void act.drain();
  });

  const t1 = await act.do(
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
  await act.do(
    "AssignTicket",
    { stream: t1.event!.stream, actor },
    {
      agentId: randomUUID(),
      reassignAfter: new Date(),
      escalateAfter: new Date(),
    }
  );

  await rand_sleep(5_000);
  await act.do(
    "AddMessage",
    { stream: t1.event!.stream, actor },
    {
      body: chance.name(),
      to: t1.state.userId,
      attachments: {},
    }
  );

  await rand_sleep(15_000);
  await act.do(
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
  await act.query(
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
