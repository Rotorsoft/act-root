import { fixture } from "@rotorsoft/act/test";
import { describe, expect } from "vitest";
import {
  builder,
  claim,
  open,
  SHARDS,
  Slots,
  taken,
} from "./split-hot-stream.js";

const test = fixture(builder);

describe("splitting a hot resource", () => {
  test("shares the slots across its streams, with none lost", async ({
    app,
  }) => {
    await open(app, "s1", SHARDS * 2 + 1);
    const shares = await Promise.all(
      Array.from(
        { length: SHARDS },
        async (_, i) => (await app.load(Slots, `slots-s1-${i}`)).state.slots
      )
    );
    expect(shares).toEqual([3, 2, 2, 2]);
  });

  test("buyers racing take exactly the slots there are", async ({ app }) => {
    await open(app, "s2", 10);
    const results = await Promise.all(
      Array.from({ length: 14 }, (_, i) => claim(app, "s2", `b${i}`))
    );
    expect(results.filter(Boolean).length).toBe(10);
    expect(await taken(app, "s2")).toBe(10);
  });

  test("a buyer moves on from a full stream", async ({ app }) => {
    await open(app, "s3", SHARDS);
    for (let i = 0; i < SHARDS; i++)
      expect(await claim(app, "s3", `b${i}`)).toBe(true);
    expect(await taken(app, "s3")).toBe(SHARDS);
  });

  test("a buyer who has a slot can't take another", async ({ app }) => {
    await open(app, "s5", SHARDS * 2);
    expect(await claim(app, "s5", "twice")).toBe(true);
    expect(await claim(app, "s5", "twice")).toBe(false);
    expect(await taken(app, "s5")).toBe(1);
  });

  test("it's sold out only when every stream is full", async ({ app }) => {
    await open(app, "s4", 1);
    expect(await claim(app, "s4", "first")).toBe(true);
    expect(await claim(app, "s4", "second")).toBe(false);
  });
});
