import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  act,
  Actor,
  AsCommitted,
  dispose,
  sleep,
  state,
  store,
} from "../src/index.js";

const A1 = state("A1", z.object({}))
  .init(() => ({}))
  .emits({
    Event1: z.object({ e1: z.number() }),
    Event2: z.object({ e2: z.string() }),
  })
  .patch({
    Event1: () => ({}),
    Event2: () => ({}),
  })
  .on("Act1", z.object({ e1: z.number() }))
  .emit(() => ["Event1", { e1: 1 }])
  .on("Act2", z.object({ e2: z.string() }))
  .emit(() => ["Event2", { e2: "2" }])
  .build();

describe("Broker", () => {
  const actor: Actor = { id: "1", name: "Actor" };
  const builder = act().with(A1);
  const app = builder
    .on("Event1")
    .do(R1, {
      maxRetries: 2,
      retryDelayMs: 5,
    })
    .build();

  async function R1(event: AsCommitted<typeof builder.events, "Event1">) {
    await app.do("Act1", { stream: "A", actor }, event.data, event);
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

    const d1 = await app.drain();
    await sleep(1_000);
    const d2 = await app.drain();
    await sleep();

    expect(d1).toEqual(0);
    expect(d2).toEqual(0);
  });
});
