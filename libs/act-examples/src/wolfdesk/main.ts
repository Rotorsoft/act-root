import { Actor, sleep } from "@rotorsoft/act";
import { Chance } from "chance";
import { randomUUID } from "crypto";
import { db, tickets } from "../drizzle";
import { act, connect_broker, Priority, start_jobs } from "./bootstrap";

const chance = new Chance();
const rand_sleep = (max = 10_000) => sleep(chance.integer({ min: 100, max }));

async function main() {
  await db.delete(tickets).execute();

  const actor: Actor = { id: randomUUID(), name: "WolfDesk" };
  const broker = connect_broker(true);
  start_jobs();
  broker.on("drained", async () => {
    const all = await db.select().from(tickets).execute();
    console.table(all);
  });
  act.on("committed", () => {
    void broker.drain();
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
}

void main();
