import { describe, expect, it } from "vitest";
import { buildModel } from "../src/client/lib/build-model.js";
import type { FileTab } from "../src/client/types/file-tab.js";

describe("buildModel direct tests", () => {
  it("fixupReactions joins all files when no sourceFile provided (line 66)", () => {
    const files: FileTab[] = [
      {
        path: "src/slices.ts",
        content: `.on("Created").do(onCreated).to(() => "t")`,
      },
    ];
    const result = {
      states: [],
      slices: [
        {
          _tag: "Slice",
          _varName: "MySlice",
          states: [],
          projections: [],
          reactions: [
            {
              event: "Created",
              handlerName: "on Created",
              dispatches: [],
              isVoid: false,
            },
          ],
        },
      ],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, files, new Map());
    const sl = model.slices.find((s) => s.name === "MySlice");
    expect(sl).toBeDefined();
    // The "on Created" handler name should be fixed up to "onCreated"
    expect(sl!.reactions[0].handlerName).toBe("onCreated");
  });

  it("act builder states not already in stateByRef (lines 134-136)", () => {
    const actOnlyState = {
      _tag: "State",
      name: "ActOnlyState",
      events: { Evt1: {} },
      actions: { doIt: {} },
      given: {},
      patches: new Map(),
    };
    const result = {
      states: [], // state NOT in rawStates
      slices: [],
      projections: [],
      acts: [
        {
          _tag: "Act",
          states: [actOnlyState], // state only here
          slices: [],
          projections: [],
          reactions: [],
        },
      ],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    const st = model.states.find((s) => s.name === "ActOnlyState");
    expect(st).toBeDefined();
    expect(st!.events).toHaveLength(1);
    expect(st!.events[0].name).toBe("Evt1");
  });

  it("slice with null state reference produces Missing state reference (lines 166-167)", () => {
    const result = {
      states: [],
      slices: [
        {
          _tag: "Slice",
          _varName: "BrokenSlice",
          states: [null, undefined],
          projections: [],
          reactions: [],
        },
      ],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    const sl = model.slices.find((s) => s.name === "BrokenSlice");
    expect(sl).toBeDefined();
    expect(sl!.error).toContain("broken import");
  });

  it("slice state not in stateByRef, tries addState in-place success (lines 173-180)", () => {
    const inlineState = {
      _tag: "State",
      name: "InlineSliceState",
      events: { Evt1: {} },
      actions: { doIt: {} },
      given: {},
      patches: new Map(),
    };
    const result = {
      states: [], // state NOT pre-built
      slices: [
        {
          _tag: "Slice",
          _varName: "TestSlice",
          states: [inlineState],
          projections: [],
          reactions: [],
        },
      ],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    const sl = model.slices.find((s) => s.name === "TestSlice");
    expect(sl).toBeDefined();
    expect(sl!.states.length).toBe(1);
    // The state should have been added to model.states
    const st = model.states.find((s) => s.name === "InlineSliceState");
    expect(st).toBeDefined();
  });

  it("slice state not in stateByRef, addState fails (lines 181-182)", () => {
    const corruptState = {
      name: "CorruptState",
      get events(): any {
        throw new Error("corrupt events");
      },
      actions: {},
    };
    const result = {
      states: [],
      slices: [
        {
          _tag: "Slice",
          _varName: "SliceWithCorrupt",
          states: [corruptState],
          projections: [],
          reactions: [],
        },
      ],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    const sl = model.slices.find((s) => s.name === "SliceWithCorrupt");
    expect(sl).toBeDefined();
    expect(sl!.error).toContain("corrupt");
    expect(sl!.error).toContain("corrupt events");
  });

  it("slice processing catch block when entire slice build throws (lines 204-205)", () => {
    const throwingSlice = {
      _tag: "Slice",
      _varName: "ThrowSlice",
      get states(): any {
        throw new Error("boom in states getter");
      },
      projections: [],
      reactions: [],
    };
    const result = {
      states: [],
      slices: [throwingSlice],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    const sl = model.slices.find((s) => s.name === "ThrowSlice");
    expect(sl).toBeDefined();
    expect(sl!.error).toContain("boom in states getter");
    expect(sl!.states).toHaveLength(0);
  });

  it("global error return when result.error exists and no states/slices (line 307)", () => {
    const result = {
      states: [],
      slices: [],
      projections: [],
      acts: [],
      error: "Global extraction failed",
      fileErrors: new Map<string, string>(),
    };
    const { model, error } = buildModel(result, [], new Map());
    expect(error).toBe("Global extraction failed");
    expect(model.states).toHaveLength(0);
    expect(model.slices).toHaveLength(0);
  });

  it("buildState returns error when event has undefined schema (line 31)", () => {
    const stateWithUndefinedEvent = {
      _tag: "State",
      name: "BadState",
      events: { Evt1: undefined },
      actions: {},
      given: {},
      patches: new Map(),
    };
    const result = {
      states: [stateWithUndefinedEvent],
      slices: [],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    // State with undefined event schema should not appear in model.states
    expect(model.states.find((s) => s.name === "BadState")).toBeUndefined();
  });

  it("buildState returns error when action has undefined schema (line 37)", () => {
    const stateWithUndefinedAction = {
      _tag: "State",
      name: "BadActionState",
      events: { Evt1: {} },
      actions: { doIt: undefined },
      given: {},
      patches: new Map(),
    };
    const result = {
      states: [stateWithUndefinedAction],
      slices: [],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    expect(
      model.states.find((s) => s.name === "BadActionState")
    ).toBeUndefined();
  });

  it("step 1 catch block for corrupted state (line 144)", () => {
    const corruptState = {
      _tag: "State",
      get name(): string {
        throw new Error("corrupt name getter");
      },
      events: {},
      actions: {},
    };
    const result = {
      states: [corruptState],
      slices: [],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    // Should not crash -- corrupt state is skipped
    expect(model).toBeDefined();
  });

  it("step 1 catch block for act-builder state (line 156)", () => {
    const corruptState = {
      _tag: "State",
      get name(): string {
        throw new Error("corrupt act state");
      },
      events: {},
      actions: {},
    };
    const result = {
      states: [],
      slices: [],
      projections: [],
      acts: [
        {
          _tag: "Act",
          states: [corruptState],
          slices: [],
          projections: [],
          reactions: [],
        },
      ],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    expect(model).toBeDefined();
  });

  it("slice state already built with error in step 1, referenced from slice (line 190)", () => {
    const badState = {
      _tag: "State",
      name: "BadState",
      events: { Evt1: undefined }, // undefined schema -> buildState returns error
      actions: {},
      given: {},
      patches: new Map(),
    };
    const result = {
      states: [badState], // step 1 builds this and stores {error} in stateByRef
      slices: [
        {
          _tag: "Slice",
          _varName: "SliceRefBadState",
          states: [badState], // same object reference -- found in stateByRef with error
          projections: [],
          reactions: [],
        },
      ],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    const sl = model.slices.find((s) => s.name === "SliceRefBadState");
    expect(sl).toBeDefined();
    expect(sl!.error).toContain("undefined schema");
    expect(sl!.states).toHaveLength(0);
  });

  it("slice state buildState returns error (line 190)", () => {
    const stateWithBadEvent = {
      _tag: "State",
      name: "SliceBadEvtState",
      events: { BadEvt: undefined },
      actions: {},
      given: {},
      patches: new Map(),
    };
    const result = {
      states: [], // not pre-built
      slices: [
        {
          _tag: "Slice",
          _varName: "SliceWithBadState",
          states: [stateWithBadEvent],
          projections: [],
          reactions: [],
        },
      ],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    const sl = model.slices.find((s) => s.name === "SliceWithBadState");
    expect(sl).toBeDefined();
    expect(sl!.error).toContain("undefined schema");
  });

  it("duplicate state in rawStates triggers stateByRef.has continue (line 140)", () => {
    const stateObj = {
      _tag: "State",
      name: "DupState",
      events: { E: {} },
      actions: { a: {} },
      given: {},
      patches: new Map(),
    };
    const result = {
      states: [stateObj, stateObj], // same reference twice
      slices: [],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    // Should only produce one state
    expect(model.states.filter((s) => s.name === "DupState")).toHaveLength(1);
  });

  it("fixupReactions returns early when sourceFile not in files (line 84)", () => {
    const result = {
      states: [],
      slices: [],
      projections: [],
      acts: [
        {
          _tag: "Act",
          _sourceFile: "src/nonexistent.ts",
          states: [],
          slices: [],
          projections: [],
          reactions: [
            {
              event: "Created",
              handlerName: "on Created",
              dispatches: [],
              isVoid: false,
            },
          ],
        },
      ],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    // Pass no matching files -- fixupReactions should return early
    const { model } = buildModel(result, [], new Map());
    // Handler name stays unfixed since source file wasn't found
    expect(model.reactions[0].handlerName).toBe("on Created");
  });

  it("act builder skips duplicate state via stateByRef.has (step 1 + act states)", () => {
    const stateObj = {
      _tag: "State",
      name: "SharedState",
      events: { E: {} },
      actions: { a: {} },
      given: {},
      patches: new Map(),
    };
    const result = {
      states: [stateObj], // pre-built in step 1
      slices: [],
      projections: [],
      acts: [
        {
          _tag: "Act",
          states: [stateObj], // same reference -- already in stateByRef
          slices: [],
          projections: [],
          reactions: [],
        },
      ],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    expect(model.states.filter((s) => s.name === "SharedState")).toHaveLength(
      1
    );
  });

  it("buildState with null events and actions (lines 28, 33 ?? fallback)", () => {
    const stateObj = {
      _tag: "State",
      name: "NullState",
      events: null, // triggers ?? {} fallback at line 28
      actions: null, // triggers ?? {} fallback at line 33
      given: null,
      patches: null,
    };
    const result = {
      states: [stateObj],
      slices: [],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    const st = model.states.find((s) => s.name === "NullState");
    expect(st).toBeDefined();
    expect(st!.events).toHaveLength(0);
    expect(st!.actions).toHaveLength(0);
  });

  it("buildState with events but null patches (line 47 ?? false fallback)", () => {
    const stateObj = {
      _tag: "State",
      name: "NoPatchState",
      events: { Evt1: {} },
      actions: {},
      given: {},
      patches: null, // triggers ?. ?? false at line 47
    };
    const result = {
      states: [stateObj],
      slices: [],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    const st = model.states.find((s) => s.name === "NoPatchState");
    expect(st).toBeDefined();
    expect(st!.events[0].hasCustomPatch).toBe(false);
  });

  it("fixupReactions: handler name in source but no matching fallback (line 95 false)", () => {
    const result = {
      states: [],
      slices: [
        {
          _tag: "Slice",
          _varName: "TestSlice",
          states: [],
          projections: [],
          reactions: [
            {
              event: "SomeOtherEvent",
              handlerName: "on SomeOtherEvent",
              dispatches: [],
              isVoid: false,
            },
          ],
        },
      ],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const files: FileTab[] = [
      {
        path: "src/s.ts",
        // Source has .on("Created").do(onCreated) but reaction is for SomeOtherEvent
        content: `.on("Created").do(onCreated).to("items")`,
      },
    ];
    const { model } = buildModel(result, files, new Map());
    // Handler name stays as "on SomeOtherEvent" since no match for "Created"
    expect(model.slices[0].reactions[0].handlerName).toBe("on SomeOtherEvent");
  });

  it("step 1 catch with non-Error thrown (line 145 false branch)", () => {
    const corruptState = {
      _tag: "State",
      get name(): string {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw { toString: () => "string error" };
      },
      events: {},
      actions: {},
    };
    const result = {
      states: [corruptState],
      slices: [],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    expect(model).toBeDefined();
  });

  it("act builder with undefined states array (line 151 ?? fallback)", () => {
    const result = {
      states: [],
      slices: [],
      projections: [],
      acts: [
        {
          _tag: "Act",
          states: undefined, // triggers ?? [] at line 151
          slices: [],
          projections: [],
          reactions: [],
        },
      ],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    expect(model).toBeDefined();
  });

  it("act builder catch with non-Error (line 157 false branch)", () => {
    const corruptState = {
      _tag: "State",
      get name(): string {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw { toString: () => "corrupt string" };
      },
      events: {},
      actions: {},
    };
    const result = {
      states: [],
      slices: [],
      projections: [],
      acts: [
        {
          _tag: "Act",
          states: [corruptState],
          slices: [],
          projections: [],
          reactions: [],
        },
      ],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    expect(model).toBeDefined();
  });

  it("slice with undefined _varName uses 'slice' default (line 167)", () => {
    const result = {
      states: [],
      slices: [
        {
          _tag: "Slice",
          // _varName undefined -> defaults to "slice" at line 167
          states: [],
          projections: [],
          reactions: [],
        },
      ],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    expect(model.slices[0].name).toBe("slice");
  });

  it("slice with null state and fileError (line 180)", () => {
    const result = {
      states: [],
      slices: [
        {
          _tag: "Slice",
          _varName: "BrokenSlice",
          states: [null],
          projections: [],
          reactions: [],
        },
      ],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map([["src/broken.ts", "Import failed"]]),
    };
    const { model } = buildModel(result, [], new Map());
    const sl = model.slices.find((s) => s.name === "BrokenSlice");
    expect(sl!.error).toContain("Import failed");
  });

  it("slice state buildState throws non-Error (line 205 false branch)", () => {
    const corruptState = {
      _tag: "State", // must have _tag so it passes typeof check
      get name(): string {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw { toString: () => "string thrown in buildState" };
      },
      events: {},
      actions: {},
    };
    const result = {
      states: [], // not pre-built
      slices: [
        {
          _tag: "Slice",
          _varName: "SliceWithCorruptState",
          states: [corruptState],
          projections: [],
          reactions: [],
        },
      ],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    const sl = model.slices.find((s) => s.name === "SliceWithCorruptState");
    expect(sl!.error).toContain("string thrown in buildState");
  });

  it("slice with undefined states array (line 180 ?? fallback)", () => {
    const result = {
      states: [],
      slices: [
        {
          _tag: "Slice",
          _varName: "NullStatesSlice",
          states: undefined as any, // triggers ?? [] at line 180
          projections: [],
          reactions: [],
        },
      ],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    const sl = model.slices.find((s) => s.name === "NullStatesSlice");
    expect(sl).toBeDefined();
    expect(sl!.states).toHaveLength(0);
  });

  it("slice catch with non-Error (line 205 false branch)", () => {
    const throwingSlice = {
      _tag: "Slice",
      _varName: "ThrowSlice2",
      get states(): any {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw { toString: () => "string thrown" };
      },
      projections: [],
      reactions: [],
    };
    const result = {
      states: [],
      slices: [throwingSlice],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    const sl = model.slices.find((s) => s.name === "ThrowSlice2");
    expect(sl!.error).toBe("string thrown");
  });

  it("slice with undefined projections (line 213 ?? fallback)", () => {
    const result = {
      states: [],
      slices: [
        {
          _tag: "Slice",
          _varName: "NoProjSlice",
          states: [],
          projections: undefined as any,
          reactions: [],
        },
      ],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    const sl = model.slices.find((s) => s.name === "NoProjSlice");
    expect(sl!.projections).toHaveLength(0);
  });

  it("slice projection with non-Projection _tag (line 213-214)", () => {
    const result = {
      states: [],
      slices: [
        {
          _tag: "Slice",
          _varName: "Sl",
          states: [],
          projections: [{ _tag: "NotAProjection", target: "fake" }, null],
          reactions: [],
        },
      ],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    const sl = model.slices.find((s) => s.name === "Sl");
    expect(sl!.projections).toHaveLength(0);
  });

  it("slice with undefined reactions (line 222)", () => {
    const result = {
      states: [],
      slices: [
        {
          _tag: "Slice",
          _varName: "Sl",
          states: [],
          projections: [],
          reactions: undefined as any,
        },
      ],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    const sl = model.slices.find((s) => s.name === "Sl");
    expect(sl!.reactions).toEqual([]);
  });

  it("slice catch with non-Error from fixupReactions (line 227)", () => {
    const result = {
      states: [],
      slices: [
        {
          _tag: "Slice",
          _varName: "Sl",
          states: [],
          projections: [],
          reactions: [],
          // _sourceFile undefined -> at line 227 'file: s._sourceFile as string | undefined'
        },
      ],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    expect(model.slices[0].file).toBeUndefined();
  });

  it("expectedSlices produces error from result.error or fallback (lines 250-252)", () => {
    const result = {
      states: [],
      slices: [],
      projections: [],
      acts: [],
      error: "Global error",
      fileErrors: new Map([["src/sl.ts", "file-specific error"]]),
    };
    const expectedSlices = new Map([
      ["MissingSlice", "src/sl.ts"],
      ["AnotherMissing", "src/other.ts"],
    ]);
    const { model } = buildModel(result, [], expectedSlices);
    const sl1 = model.slices.find((s) => s.name === "MissingSlice");
    expect(sl1!.error).toBe("file-specific error");
    const sl2 = model.slices.find((s) => s.name === "AnotherMissing");
    // Falls through to result.error since no file error for src/other.ts
    expect(sl2!.error).toBe("Global error");
  });

  it("expectedSlices fallback to 'Failed to build slice' (line 252)", () => {
    const result = {
      states: [],
      slices: [],
      projections: [],
      acts: [],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const expectedSlices = new Map([["Missing", "src/m.ts"]]);
    const { model } = buildModel(result, [], expectedSlices);
    const sl = model.slices.find((s) => s.name === "Missing");
    expect(sl!.error).toBe("Failed to build slice");
  });

  it("act with undefined reactions (line 290 ?? fallback)", () => {
    const result = {
      states: [],
      slices: [],
      projections: [],
      acts: [
        {
          _tag: "Act",
          states: [],
          slices: [],
          projections: [],
          reactions: undefined as any,
          _sourceFile: "src/app.ts",
        },
      ],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    expect(model.reactions).toHaveLength(0);
  });

  it("act entry with reactions fallback (line 300 ?? fallback)", () => {
    const result = {
      states: [],
      slices: [],
      projections: [],
      acts: [
        {
          _tag: "Act",
          states: [],
          slices: [],
          projections: [],
          reactions: undefined as any,
        },
      ],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    expect(model.entries).toHaveLength(1);
    expect(model.entries[0].reactions).toEqual([]);
  });

  it("act with null slices array (line 190 || fallback)", () => {
    const result = {
      states: [],
      slices: [],
      projections: [],
      acts: [
        {
          _tag: "Act",
          states: [],
          slices: null as any, // triggers || [] at line 190
          projections: [],
          reactions: [],
          _sourceFile: "src/app.ts",
        },
      ],
      error: undefined,
      fileErrors: new Map<string, string>(),
    };
    const { model } = buildModel(result, [], new Map());
    expect(model).toBeDefined();
  });
});
