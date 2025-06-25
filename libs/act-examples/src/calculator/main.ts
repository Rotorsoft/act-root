import { act, Actor, sleep, state, ZodEmpty } from "@rotorsoft/act";
import { randomUUID } from "crypto";
import { z } from "zod/v4";
import { Calculator, KEYS } from "./calculator.js";

export const NineCounter = state(
  "NineCounter",
  z.object({
    nines: z.number().int(),
    equals: z.number().int(),
  })
)
  .init(() => ({ nines: 0, equals: 0 }))
  .emits({
    NineCounted: ZodEmpty,
    EqualCounted: ZodEmpty,
  })
  .patch({
    NineCounted: (_, state) => ({ nines: (state.nines || 0) + 1 }),
    EqualCounted: (_, state) => ({ equals: (state.equals || 0) + 1 }),
  })
  .on("Count", z.object({ key: z.enum(KEYS) }))
  .emit(({ key }) => {
    if (key === "9") return ["NineCounted", {}];
    if (key === "=") return ["EqualCounted", {}];
  })
  .build();

// prettier-ignore
async function main() {
  // to test with postgres
  // store(new PostgresStore({ schema: "act", table: "calculator", leaseMillis: 30_000 }));
  // await store().drop();
  // await store().seed();

  const actor: Actor = { id: randomUUID(), name: "Calculator" };
  
  const app = act()
    .with(Calculator)
    .with(NineCounter)
    
    .on("DigitPressed").do(async function CountNines(event, stream) {
      await app.do("Count", { stream, actor }, { key: event.data.digit }, event);
    }).to(() => "Counter")
    .on("EqualsPressed").do(async function CountEquals(event, stream) {
      await app.do( "Count", { stream, actor }, { key: "=" }, event);
    }).to(() => "Counter")

    .on("EqualCounted").do(async function ShowMessage({ stream }) { 
      await sleep();
      console.log(`Equals counted on ${stream}`);
    }).void()
    
    .build();

  // drain on commit
  app.on("committed", () => {
    void app.drain();
  });

  // drain on a schedule
  setInterval(() => {
    void app.drain();
  }, 1_000);

  // log drains
  app.on("drained", (drained) => {
    console.log("Drained:", drained);
  });

  const calc1 = "A";
  const calc2 = "B";

  await app.do("PressKey", { stream: calc1, actor }, { key: "9" });
  await app.do("PressKey", { stream: calc1, actor }, { key: "9" });
  await app.do("PressKey", { stream: calc1, actor }, { key: "+" });
  await app.do("PressKey", { stream: calc1, actor }, { key: "9" });
  await app.do("PressKey", { stream: calc1, actor }, { key: "*" });
  await app.do("PressKey", { stream: calc2, actor }, { key: "9" });
  await app.do("PressKey", { stream: calc1, actor }, { key: "9" });
  await app.do("PressKey", { stream: calc2, actor }, { key: "9" });
  await app.do("PressKey", { stream: calc1, actor }, { key: "9" });
  await app.do("PressKey", { stream: calc2, actor }, { key: "+" });
  await app.do("PressKey", { stream: calc2, actor }, { key: "9" });
  await app.do("PressKey", { stream: calc1, actor }, { key: "9" });
  await app.do("PressKey", { stream: calc1, actor }, { key: "=" });
  await app.do("PressKey", { stream: calc2, actor }, { key: "=" });

  console.log(calc1, await app.load(Calculator, calc1));
  console.log(calc2, await app.load(Calculator, calc2));

  setInterval(async () => {
    const counter = await app.load(NineCounter, "Counter");
    console.log("Counter", counter.state);
  }, 1_000);
}

void main();
