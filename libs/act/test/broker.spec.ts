import { z } from "zod";
import {
  ActBuilder,
  Actor,
  AsCommitted,
  BrokerBuilder,
  dispose,
  Infer,
  sleep,
  store,
} from "../src";

const events = {
  Event1: z.object({ e1: z.number() }),
  Event2: z.object({ e2: z.string() }),
};
const actions = {
  Act1: z.object({ e1: z.number() }),
  Act2: z.object({ e2: z.string() }),
};
const schemas = { events, actions, state: z.object({}) };

function A1(): Infer<typeof schemas> {
  return {
    ...schemas,
    init: () => ({}),
    patch: { Event1: () => ({}), Event2: () => ({}) },
    on: {
      Act1: () => Promise.resolve(["Event1", { e1: 1 }]),
      Act2: () => Promise.resolve(["Event2", { e2: "2" }]),
    },
  };
}

describe("Broker", () => {
  const actor: Actor = { id: "1", name: "Actor" };
  const act = new ActBuilder().with(A1).build();

  async function R1(event: AsCommitted<typeof act, "Event1">) {
    await act.do("Act1", { stream: "A", actor }, event.data, event);
  }

  const broker = new BrokerBuilder(act.events)
    .when("Event1")
    .do(R1, {
      maxRetries: 2,
      retryDelayMs: 5,
    })
    .build();

  afterEach(async () => {
    await dispose()();
  });

  it("should block stream with invalid event", async () => {
    // insert invalid event
    await store().commit("A", [{ name: "Event1", data: {} }], {
      correlation: "",
      causation: {},
    });

    const d1 = await broker.drain();
    await sleep(1_000);
    const d2 = await broker.drain();
    await sleep();

    expect(d1).toEqual(0);
    expect(d2).toEqual(0);
  });
});
