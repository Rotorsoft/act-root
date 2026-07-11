import {
  type Actor,
  act,
  dispose,
  InvariantError,
  ValidationError,
} from "@rotorsoft/act";
import { Calculator } from "../src/index.js";

describe("calculator invariants", () => {
  const actor: Actor = { id: "1", name: "Calculator" };
  const stream = "I";
  const app = act().withState(Calculator).build();

  afterAll(async () => {
    await dispose()();
  });

  it("should throw invariant error", async () => {
    await app.do("PressKey", { stream, actor }, { key: "1" });
    await app.do("Clear", { stream, actor }, {});
    await expect(app.do("Clear", { stream, actor }, {})).rejects.toThrow(
      InvariantError
    );
  });

  it("should throw validation error", async () => {
    await expect(
      // @ts-expect-error invalid action
      app.do("PressKey", { stream, actor }, { key: 123 })
    ).rejects.toThrow(ValidationError);
  });

  it("should throw no operator error", async () => {
    await expect(
      app.do("PressKey", { stream: "C", actor }, { key: "=" })
    ).rejects.toThrow("no operator");
  });

  it("should throw missing target stream error", async () => {
    await expect(
      // @ts-expect-error missing stream
      app.do("PressKey", {}, { key: "=" })
    ).rejects.toThrow("Missing target stream");
  });

  // A calculator must never fold an un-representable number into its
  // state. Division by zero (Infinity) and malformed operands (NaN) used
  // to land in `result`, then `left = result.toString()` re-injected
  // "Infinity"/"NaN" into the input so it compounded on the next digit —
  // and any consumer of `result` (the ProjectResult reaction) blocked on
  // a ValidationError because `z.number()` rejects non-finite values.
  it("guards a division by zero — result stays finite", async () => {
    const s = "DZ";
    for (const key of ["1", "/", "0", "="] as const)
      await app.do("PressKey", { stream: s, actor }, { key });
    const { state } = await app.load(Calculator, s);
    expect(Number.isFinite(state.result)).toBe(true);
  });

  it("never poisons `left` with a non-finite string", async () => {
    const s = "NP";
    // Divide by zero, then keep pressing digits: `left` must stay a
    // parseable finite number (or empty), never "Infinity38"/"NaN38".
    for (const key of ["5", "/", "0", "=", "3", "8"] as const)
      await app.do("PressKey", { stream: s, actor }, { key });
    const { state } = await app.load(Calculator, s);
    expect(
      state.left === undefined || Number.isFinite(Number.parseFloat(state.left))
    ).toBe(true);
    expect(Number.isFinite(state.result)).toBe(true);
  });
});
