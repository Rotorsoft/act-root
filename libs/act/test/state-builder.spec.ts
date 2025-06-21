import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { state } from "../src/state-builder.js";

const counter = z.object({
  count: z.number(),
});
const events = {
  Incremented: z.object({ by: z.number() }),
};
const patch = {
  Incremented: vi.fn(),
};

describe("state-builder", () => {
  it("should throw on duplicate action", () => {
    const builder = state("test", counter)
      .init(() => ({ count: 0 }))
      .emits(events)
      .patch(patch)
      .on("inc", z.object({}))
      .emit(() => ["Incremented", { by: 1 }]);

    expect(() =>
      builder.on("inc", z.object({})).emit(() => ["Incremented", { by: 1 }])
    ).toThrow('Duplicate action "inc"');
  });

  it("should build a state with given and snap", () => {
    const machine = state("test", counter)
      .init(() => ({ count: 0 }))
      .emits(events)
      .patch(patch)
      .on("inc", z.object({}))
      .given([])
      .emit(() => ["Incremented", { by: 1 }])
      .snap(() => true)
      .build();

    expect(machine.name).toBe("test");
    expect(machine.on.inc).toBeDefined();
    expect(machine.given?.inc).toBeDefined();
    expect(machine.snap).toBeDefined();
  });
});
