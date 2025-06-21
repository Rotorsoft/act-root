import {
  act,
  Actor,
  dispose,
  InvariantError,
  ValidationError,
} from "@rotorsoft/act";
import { afterAll, describe, expect, it } from "vitest";
import { Calculator } from "../../src/calculator/index.js";

describe("calculator invariants", () => {
  const actor: Actor = { id: "1", name: "Calculator" };
  const stream = "I";
  const app = act().with(Calculator).build();

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
});
