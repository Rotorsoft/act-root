import { describe, expect, it } from "vitest";
import { validate } from "../src/client/lib/validate.js";
import type { DomainModel } from "../src/client/types/domain-model.js";
import { emptyModel } from "../src/client/types/domain-model.js";

describe("validate", () => {
  it("warns about actions that don't emit events", () => {
    const model: DomainModel = {
      entries: [],
      states: [
        {
          name: "Foo",
          varName: "Foo:0",
          events: [{ name: "Done", hasCustomPatch: false }],
          actions: [{ name: "doSomething", emits: [], invariants: [] }],
        },
      ],
      slices: [],
      projections: [],
      reactions: [],
    };

    const warnings = validate(model);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("doSomething");
    expect(warnings[0].severity).toBe("warning");
    expect(warnings[0].element).toBe("doSomething");
  });

  it("returns no warnings for a valid model", () => {
    const model: DomainModel = {
      entries: [],
      states: [
        {
          name: "Bar",
          varName: "Bar:0",
          events: [{ name: "Created", hasCustomPatch: false }],
          actions: [{ name: "create", emits: ["Created"], invariants: [] }],
        },
      ],
      slices: [],
      projections: [],
      reactions: [],
    };

    const warnings = validate(model);
    expect(warnings).toHaveLength(0);
  });

  it("returns no warnings for empty model", () => {
    const model: DomainModel = {
      entries: [],
      states: [],
      slices: [],
      projections: [],
      reactions: [],
    };
    expect(validate(model)).toHaveLength(0);
  });
});

describe("emptyModel", () => {
  it("returns a valid empty DomainModel", () => {
    const model = emptyModel();
    expect(model.entries).toEqual([]);
    expect(model.states).toEqual([]);
    expect(model.slices).toEqual([]);
    expect(model.projections).toEqual([]);
    expect(model.reactions).toEqual([]);
    expect(model.orchestrator).toBeUndefined();
  });
});
