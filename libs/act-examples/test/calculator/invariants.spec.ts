import {
  ActBuilder,
  dispose,
  InvariantError,
  ValidationError,
} from "@rotorsoft/act";
import { Calculator } from "../../src/calculator";

describe("calculator invariants", () => {
  const stream = "I";
  const act = new ActBuilder().with(Calculator).build();

  afterAll(async () => {
    await dispose()();
  });

  it("should throw invariant error", async () => {
    await act.do("PressKey", { stream }, { key: "1" });
    await act.do("Clear", { stream }, {});
    await expect(act.do("Clear", { stream }, {})).rejects.toThrow(
      InvariantError
    );
  });

  it("should throw validation error", async () => {
    await expect(
      // @ts-expect-error invalid action
      act.do("PressKey", { stream }, { key: 123 })
    ).rejects.toThrow(ValidationError);
  });

  it("should throw no operator error", async () => {
    await expect(
      act.do("PressKey", { stream: "C" }, { key: "=" })
    ).rejects.toThrow("no operator");
  });

  it("should throw missing target stream error", async () => {
    await expect(
      // @ts-expect-error missing stream
      act.do("PressKey", {}, { key: "=" })
    ).rejects.toThrow("Missing target stream");
  });
});
