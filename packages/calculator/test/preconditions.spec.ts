import {
  type Actor,
  act,
  PreconditionError,
  ValidationError,
} from "@rotorsoft/act";
import { sandbox } from "@rotorsoft/act/test";
import { Calculator } from "../src/index.js";

const builder = act().withState(Calculator);

describe("calculator preconditions", () => {
  const actor: Actor = { id: "1", name: "Calculator" };
  const stream = "I";
  // Shared isolated Act for the whole suite (the cases build on each other's
  // stream state), wired once in beforeAll and torn down in afterAll.
  let app: ReturnType<typeof builder.build>;
  let dispose: () => Promise<void>;

  beforeAll(async () => {
    // The state schema is the calculator's invariant (the result is always a
    // finite number), checked before every commit.
    ({ app, dispose } = await sandbox(builder));
  });

  afterAll(async () => {
    await dispose();
  });

  it("should throw precondition error", async () => {
    await app.do("PressKey", { stream, actor }, { key: "1" });
    await app.do("Clear", { stream, actor }, {});
    await expect(app.do("Clear", { stream, actor }, {})).rejects.toThrow(
      PreconditionError
    );
  });

  it("should throw validation error", async () => {
    await expect(
      // @ts-expect-error invalid action
      app.do("PressKey", { stream, actor }, { key: 123 })
    ).rejects.toThrow(ValidationError);
  });

  it("refuses = with no operator, as a precondition", async () => {
    await expect(
      app.do("PressKey", { stream: "C", actor }, { key: "=" })
    ).rejects.toMatchObject({
      name: "ERR_PRECONDITION",
      message: "PressKey failed precondition: Equals needs an operator",
    });
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
