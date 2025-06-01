import { z } from "zod/v4";
import {
  ActBuilder,
  Actor,
  AsCommitted,
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
  const builder = new ActBuilder().with(A1);
  const act = builder
    .on("Event1")
    .do(R1, {
      maxRetries: 2,
      retryDelayMs: 5,
    })
    .build();

  async function R1(event: AsCommitted<typeof builder.events, "Event1">) {
    await act.do("Act1", { stream: "A", actor }, event.data, event);
  }

  afterEach(async () => {
    await dispose()();
  });

  it("should block stream with invalid event", async () => {
    // insert invalid event
    await store().commit("A", [{ name: "Event1", data: {} }], {
      correlation: "",
      causation: {},
    });

    const d1 = await act.drain();
    await sleep(1_000);
    const d2 = await act.drain();
    await sleep();

    expect(d1).toEqual(0);
    expect(d2).toEqual(0);
  });
});
