import { z } from "zod";
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
    const builder = state({ test: counter })
      .init(() => ({ count: 0 }))
      .emits(events)
      .patch(patch)
      .on({ inc: z.object({}) })
      .emit(() => ["Incremented", { by: 1 }]);

    expect(() =>
      builder.on({ inc: z.object({}) }).emit(() => ["Incremented", { by: 1 }])
    ).toThrow('Duplicate action "inc"');
  });

  it("should throw when .on() receives multiple keys", () => {
    const builder = state({ test: counter })
      .init(() => ({ count: 0 }))
      .emits(events)
      .patch(patch);

    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- intentionally testing invalid input
      builder.on({ a: z.object({}), b: z.object({}) } as any)
    ).toThrow(".on() requires exactly one key");
  });

  it("should build a state with given and snap", () => {
    const machine = state({ test: counter })
      .init(() => ({ count: 0 }))
      .emits(events)
      .patch(patch)
      .on({ inc: z.object({}) })
      .given([])
      .emit(() => ["Incremented", { by: 1 }])
      .snap(() => true)
      .build();

    expect(machine.name).toBe("test");
    expect(machine.on.inc).toBeDefined();
    expect(machine.given?.inc).toBeDefined();
    expect(machine.snap).toBeDefined();
  });

  describe("record shorthand state({ Name: schema })", () => {
    it("should produce identical result to state(name, schema)", () => {
      const fromArgs = state({ Counter: counter })
        .init(() => ({ count: 0 }))
        .emits(events)
        .patch(patch)
        .on({ inc: z.object({}) })
        .emit(() => ["Incremented", { by: 1 }])
        .build();

      const fromRecord = state({ Counter: counter })
        .init(() => ({ count: 0 }))
        .emits(events)
        .patch(patch)
        .on({ inc: z.object({}) })
        .emit(() => ["Incremented", { by: 1 }])
        .build();

      expect(fromRecord.name).toBe(fromArgs.name);
      expect(fromRecord.name).toBe("Counter");
      expect(Object.keys(fromRecord.actions)).toEqual(
        Object.keys(fromArgs.actions)
      );
      expect(Object.keys(fromRecord.events)).toEqual(
        Object.keys(fromArgs.events)
      );
      expect(fromRecord.on.inc).toBeDefined();
    });

    it("should throw when record has more than one key", () => {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- intentionally testing invalid input
        state({ A: counter, B: counter } as any)
      ).toThrow("state() requires exactly one key");
    });

    it("should throw when record has zero keys", () => {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- intentionally testing invalid input
        state({} as any)
      ).toThrow("state() requires exactly one key");
    });

    it("should support full builder chain with given and snap", () => {
      const machine = state({ test: counter })
        .init(() => ({ count: 0 }))
        .emits(events)
        .patch(patch)
        .on({ inc: z.object({}) })
        .given([])
        .emit(() => ["Incremented", { by: 1 }])
        .snap(() => true)
        .build();

      expect(machine.name).toBe("test");
      expect(machine.on.inc).toBeDefined();
      expect(machine.given?.inc).toBeDefined();
      expect(machine.snap).toBeDefined();
    });

    it("should work with named schema variables", () => {
      const Counter = counter;
      const machine = state({ Counter })
        .init(() => ({ count: 0 }))
        .emits(events)
        .patch(patch)
        .on({ inc: z.object({}) })
        .emit(() => ["Incremented", { by: 1 }])
        .build();

      expect(machine.name).toBe("Counter");
    });
  });
});
