import {
  ActBuilder,
  Actor,
  BrokerBuilder,
  sleep,
  store,
  ZodEmpty,
  type Infer,
} from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { randomUUID } from "crypto";
import { z } from "zod";
import { Calculator, KEYS } from ".";

const NineCounterSchemas = {
  state: z.object({
    nines: z.number().int(),
    equals: z.number().int(),
  }),
  events: {
    NineCounted: ZodEmpty,
    EqualCounted: ZodEmpty,
  },
  actions: {
    Count: z.object({ key: z.enum(KEYS) }),
  },
};

export function NineCounter(): Infer<typeof NineCounterSchemas> {
  return {
    ...NineCounterSchemas,
    init: () => ({ nines: 0, equals: 0 }),
    patch: {
      NineCounted: (_, state) => ({ nines: (state.nines || 0) + 1 }),
      EqualCounted: (_, state) => ({ equals: (state.equals || 0) + 1 }),
    },
    on: {
      Count: async ({ key }) => {
        await sleep();
        if (key === "9") return ["NineCounted", {}];
        if (key === "=") return ["EqualCounted", {}];
      },
    },
  };
}

// prettier-ignore
async function main() {
  store(new PostgresStore("calculator", 30_000));
  await store().drop();
  await store().seed();

  const actor: Actor = { id: randomUUID(), name: "Calculator" };
  
  const act = new ActBuilder()
    .with(NineCounter)
    .with(Calculator)
    .build();

  const broker = new BrokerBuilder(act.events)
    .when("DigitPressed").do(async function CountNines(event, stream) {
      await act.do("Count", { stream, actor }, { key: event.data.digit }, event);
    }).to(() => "Counter")
    .when("EqualsPressed").do(async function CountEquals(event, stream) {
      await act.do( "Count", { stream, actor }, { key: "=" }, event);
    }).to("Counter")
    .when("EqualCounted").do(async function ShowMessage({ stream }) {
      await sleep();
      console.log(`Equals counted on ${stream}`);
    }).void()
    .build();

  // drain on commit
  act.on("committed", () => {
    void broker.drain();
  });
  // drain on a schedule
  setInterval(() => {
    void broker.drain();
  }, 1_000);
  // log drains
  broker.on("drained", (drained) => {
    console.log("Drained:", drained);
  });

  const calc1 = "A";
  const calc2 = "B";

  await act.do("PressKey", { stream: calc1, actor }, { key: "9" });
  await act.do("PressKey", { stream: calc1, actor }, { key: "9" });
  await act.do("PressKey", { stream: calc1, actor }, { key: "+" });
  await act.do("PressKey", { stream: calc1, actor }, { key: "9" });
  await act.do("PressKey", { stream: calc1, actor }, { key: "*" });
  await act.do("PressKey", { stream: calc2, actor }, { key: "9" });
  await act.do("PressKey", { stream: calc1, actor }, { key: "9" });
  await act.do("PressKey", { stream: calc2, actor }, { key: "9" });
  await act.do("PressKey", { stream: calc1, actor }, { key: "9" });
  await act.do("PressKey", { stream: calc2, actor }, { key: "+" });
  await act.do("PressKey", { stream: calc2, actor }, { key: "9" });
  await act.do("PressKey", { stream: calc1, actor }, { key: "9" });
  await act.do("PressKey", { stream: calc1, actor }, { key: "=" });
  await act.do("PressKey", { stream: calc2, actor }, { key: "=" });

  console.log(calc1, await act.load(Calculator, calc1));
  console.log(calc2, await act.load(Calculator, calc2));

  setInterval(async () => {
    const counter = await act.load(NineCounter, "Counter");
    console.log("Counter", counter.state);
  }, 1_000);
}

void main();
