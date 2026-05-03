import { z } from "zod";
import { state } from "../src/builders/state-builder.js";

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

  // Compile-time evidence that the fluent chain preserves type narrowing
  // for action payloads, state shape, and emitted event tuples — i.e. the
  // DevEx experience of using act() doesn't degrade to `any`.
  describe("type narrowing", () => {
    it("preserves action payload + state types in .emit handlers", () => {
      const machine = state({ Counter: counter })
        .init(() => ({ count: 0 }))
        .emits({
          Incremented: z.object({ by: z.number() }),
        })
        .on({ inc: z.object({ amount: z.number() }) })
        .emit((action, snapshot) => {
          // Action narrowed to { amount: number }
          const amount: number = action.amount;
          // State narrowed to { count: number }
          const count: number = snapshot.state.count;
          return ["Incremented", { by: amount + count }];
        })
        .build();

      expect(machine.on.inc).toBeDefined();
    });

    it("rejects unknown action fields at compile time", () => {
      state({ Counter: counter })
        .init(() => ({ count: 0 }))
        .emits({ Incremented: z.object({ by: z.number() }) })
        .on({ inc: z.object({ amount: z.number() }) })
        .emit((action) => [
          "Incremented",
          // @ts-expect-error 'wrongField' not on action's shape
          { by: action.wrongField },
        ])
        .build();
      expect(true).toBe(true);
    });

    it("rejects unknown event names in .emit at compile time", () => {
      state({ Counter: counter })
        .init(() => ({ count: 0 }))
        .emits({ Incremented: z.object({ by: z.number() }) })
        .on({ inc: z.object({}) })
        // @ts-expect-error 'NotAnEvent' isn't in .emits()
        .emit("NotAnEvent")
        .build();
      expect(true).toBe(true);
    });
  });
});
