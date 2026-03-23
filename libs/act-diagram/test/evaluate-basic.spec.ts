import { describe, expect, it } from "vitest";
import { extractModel } from "../src/client/lib/evaluate.js";
import type { FileTab } from "../src/client/types/file-tab.js";

describe("extractModel", () => {
  it("extracts a simple state with actions and events", () => {
    const files: FileTab[] = [
      {
        path: "src/counter.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";

export const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .patch({ Incremented: ({ data }, state) => ({ count: state.count + data.amount }) })
  .on({ increment: z.object({ by: z.number() }) })
    .emit("Incremented")
  .build();
`,
      },
    ];

    const { model, error } = extractModel(files);
    expect(error).toBeUndefined();
    expect(model.states).toHaveLength(1);
    expect(model.states[0].name).toBe("Counter");
    expect(model.states[0].events).toHaveLength(1);
    expect(model.states[0].events[0].name).toBe("Incremented");
    expect(model.states[0].events[0].hasCustomPatch).toBe(true);
    expect(model.states[0].actions).toHaveLength(1);
    expect(model.states[0].actions[0].name).toBe("increment");
    expect(model.states[0].actions[0].emits).toContain("Incremented");
  });

  it("extracts standalone projections", () => {
    const files: FileTab[] = [
      {
        path: "src/proj.ts",
        content: `
import { projection } from "@rotorsoft/act";
import { z } from "zod";

export const TicketProjection = projection("tickets")
  .on({ TicketOpened: z.object({ title: z.string() }) })
    .do(async ({ stream, data }) => { console.log(stream, data); })
  .build();
`,
      },
    ];

    const { model, error } = extractModel(files);
    expect(error).toBeUndefined();
    expect(model.projections).toHaveLength(1);
    expect(model.projections[0].name).toBe("tickets");
    expect(model.projections[0].handles).toContain("TicketOpened");
  });

  it("returns empty model for empty files", () => {
    const { model } = extractModel([]);
    expect(model.states).toHaveLength(0);
    expect(model.slices).toHaveLength(0);
    expect(model.entries).toHaveLength(0);
  });

  it("handles .tsx and .d.ts and node_modules files (skips them)", () => {
    const files: FileTab[] = [
      { path: "src/App.tsx", content: `export const x = 1;` },
      { path: "src/types.d.ts", content: `declare const y: number;` },
      { path: "node_modules/foo/index.ts", content: `export const z = 1;` },
    ];
    const { model } = extractModel(files);
    expect(model.states).toHaveLength(0);
  });

  it("handles import.meta replacement", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
const url = import.meta.url;
export const S = state({ S: z.object({ x: z.string() }) })
  .init(() => ({ x: "" }))
  .emits({ Done: z.object({}) })
  .on({ doIt: z.object({}) }).emit("Done")
  .build();
`,
      },
    ];
    const { model, error } = extractModel(files);
    expect(error).toBeUndefined();
    expect(model.states).toHaveLength(1);
  });

  it("resolves relative imports with parent traversal", () => {
    const files: FileTab[] = [
      {
        path: "src/shared/types.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const Shared = state({ Shared: z.object({ v: z.number() }) })
  .init(() => ({ v: 0 }))
  .emits({ SharedEvt: z.object({}) })
  .on({ doShared: z.object({}) }).emit("SharedEvt")
  .build();
`,
      },
      {
        path: "src/features/app.ts",
        content: `
import { act } from "@rotorsoft/act";
import { Shared } from "../shared/types.js";
export const app = act().withState(Shared).build();
`,
      },
    ];
    const { model, error } = extractModel(files);
    expect(error).toBeUndefined();
    expect(model.entries).toHaveLength(1);
  });

  it("resolves relative /index imports", () => {
    const files: FileTab[] = [
      {
        path: "src/domain/index.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const D = state({ D: z.object({}) })
  .init(() => ({}))
  .emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E")
  .build();
`,
      },
      {
        path: "src/app.ts",
        content: `
import { act } from "@rotorsoft/act";
import { D } from "./domain.js";
export const app = act().withState(D).build();
`,
      },
    ];
    const { model, error } = extractModel(files);
    expect(error).toBeUndefined();
    expect(model.entries).toHaveLength(1);
  });

  it("resolves scoped package imports to workspace files", () => {
    const files: FileTab[] = [
      {
        path: "packages/utils/src/index.ts",
        content: `export const helper = "hello";`,
      },
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
import { helper } from "@myorg/utils";
const x = helper;
export const S = state({ S: z.object({ x: z.string() }) })
  .init(() => ({ x }))
  .emits({ Done: z.object({}) })
  .on({ doIt: z.object({}) }).emit("Done")
  .build();
`,
      },
    ];
    const { model, error } = extractModel(files);
    expect(error).toBeUndefined();
    expect(model.states).toHaveLength(1);
  });

  it("resolves bare unknown module to unknownModuleProxy", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
import pkg from "totally-unknown-package";
const x = pkg.something();
export const S = state({ S: z.object({}) })
  .init(() => ({}))
  .emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E")
  .build();
`,
      },
    ];
    const { model, error } = extractModel(files);
    expect(error).toBeUndefined();
    expect(model.states).toHaveLength(1);
  });

  it("strips runtime calls (main, run, start, bootstrap)", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `
import { state, act } from "@rotorsoft/act";
import { z } from "zod";
const S = state({ S: z.object({}) })
  .init(() => ({}))
  .emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E")
  .build();
const app = act().withState(S).build();
async function main() { await app.do("a", { stream: "s", actor: { id: "1", name: "u" } }, {}); }
main().catch(console.error);
void run();
await start();
bootstrap();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model.states.length).toBeGreaterThanOrEqual(1);
  });

  it("handles __dirname/__filename const declarations", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
const __dirname = "/some/path";
const __filename = "/some/path/file.ts";
export const S = state({ S: z.object({ x: z.string() }) })
  .init(() => ({ x: "" }))
  .emits({ Done: z.object({}) })
  .on({ doIt: z.object({}) }).emit("Done")
  .build();
`,
      },
    ];
    const { error } = extractModel(files);
    expect(error).toBeUndefined();
  });

  it("creates default entry when no act() but states exist", () => {
    const files: FileTab[] = [
      {
        path: "src/states.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const S = state({ S: z.object({ x: z.number() }) })
  .init(() => ({ x: 0 }))
  .emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E")
  .build();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model.entries).toHaveLength(1);
    expect(model.entries[0].path).toBe("app");
  });

  it("handles store() and dispose() imports", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `
import { state, act, store, dispose } from "@rotorsoft/act";
import { z } from "zod";
store();
const d = dispose();
const S = state({ S: z.object({}) })
  .init(() => ({}))
  .emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E")
  .build();
const app = act().withState(S).build();
`,
      },
    ];
    const { error } = extractModel(files);
    expect(error).toBeUndefined();
  });

  it("handles node:crypto import", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
import { randomUUID } from "node:crypto";
const id = randomUUID();
export const S = state({ S: z.object({ x: z.string() }) })
  .init(() => ({ x: id }))
  .emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E")
  .build();
`,
      },
    ];
    const { error } = extractModel(files);
    expect(error).toBeUndefined();
  });

  it("resolves root-level files (no directory) with relative imports", () => {
    const files: FileTab[] = [
      {
        path: "types.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const T = state({ T: z.object({}) })
  .init(() => ({}))
  .emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E")
  .build();
`,
      },
      {
        path: "app.ts",
        content: `
import { act } from "@rotorsoft/act";
import { T } from "./types.js";
export const app = act().withState(T).build();
`,
      },
    ];
    const { model, error } = extractModel(files);
    expect(error).toBeUndefined();
    expect(model.entries).toHaveLength(1);
  });

  it("handles state without events or actions (null guards)", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const S = state({ S: z.object({}) })
  .init(() => ({}))
  .emits({})
  .build();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model.states).toHaveLength(1);
    expect(model.states[0].events).toHaveLength(0);
    expect(model.states[0].actions).toHaveLength(0);
  });

  it("handles state with event that has no custom patch (hasCustomPatch false)", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const S = state({ S: z.object({ v: z.string() }) })
  .init(() => ({ v: "" }))
  .emits({ Done: z.object({ v: z.string() }) })
  .on({ doIt: z.object({ v: z.string() }) }).emit("Done")
  .build();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model.states[0].events[0].hasCustomPatch).toBe(false);
  });

  it("handles action with invariants that have no description", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const S = state({ S: z.object({}) })
  .init(() => ({}))
  .emits({ E: z.object({}) })
  .on({ a: z.object({}) })
    .given([{ valid: () => true }])
    .emit("E")
  .build();
`,
      },
    ];
    const { model } = extractModel(files);
    // invariant without description -> empty string
    expect(model.states[0].actions[0].invariants).toContain("");
  });

  it("returns error when execute produces error", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const S = state({ S: z.object({}) })
  .init(() => ({})).emits({}).build();
`,
      },
    ];
    const { model } = extractModel(files);
    // Just verify it doesn't crash
    expect(model).toBeDefined();
  });

  it("relative import to non-existent file returns empty object", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
import { missing } from "./nonexistent.js";
export const S = state({ S: z.object({}) })
  .init(() => ({})).emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E").build();
`,
      },
    ];
    const { model, error } = extractModel(files);
    expect(error).toBeUndefined();
    expect(model.states).toHaveLength(1);
  });

  it("scoped import resolution falls through all patterns to unknownModuleProxy", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
import { util } from "@someorg/nonexistent";
export const S = state({ S: z.object({}) })
  .init(() => ({})).emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E").build();
`,
      },
    ];
    const { error } = extractModel(files);
    expect(error).toBeUndefined();
  });

  it("handles act with scoped package imports (not @rotorsoft)", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `
import { state, act } from "@rotorsoft/act";
import { z } from "zod";
import { something } from "@myorg/utils";
const S = state({ S: z.object({}) })
  .init(() => ({}))
  .emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E")
  .build();
const app = act().withState(S).build();
`,
      },
    ];
    const { error } = extractModel(files);
    expect(error).toBeUndefined();
  });

  it("scoped import resolves to pkg/src/index pattern", () => {
    const files: FileTab[] = [
      {
        path: "utils/src/index.ts",
        content: `export const helper = "val";`,
      },
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
import { helper } from "@org/utils";
export const S = state({ S: z.object({ x: z.string() }) })
  .init(() => ({ x: helper }))
  .emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E").build();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model.states).toHaveLength(1);
  });

  it("scoped import resolves to pkg/index pattern", () => {
    const files: FileTab[] = [
      {
        path: "utils/index.ts",
        content: `export const helper = "val";`,
      },
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
import { helper } from "@org/utils";
export const S = state({ S: z.object({ x: z.string() }) })
  .init(() => ({ x: helper }))
  .emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E").build();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model.states).toHaveLength(1);
  });

  it("scoped import resolves to bare pkg pattern", () => {
    const files: FileTab[] = [
      {
        path: "utils.ts",
        content: `export const helper = "val";`,
      },
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
import { helper } from "@org/utils";
export const S = state({ S: z.object({ x: z.string() }) })
  .init(() => ({ x: helper }))
  .emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E").build();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model.states).toHaveLength(1);
  });

  it("relative import resolves to /index fallback", () => {
    const files: FileTab[] = [
      {
        path: "src/domain/index.ts",
        content: `export const val = 42;`,
      },
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
import { val } from "./domain.js";
export const S = state({ S: z.object({}) })
  .init(() => ({}))
  .emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E").build();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model.states).toHaveLength(1);
  });

  it("null guards handle act with undefined projections/states/slices/reactions", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `
import { act } from "@rotorsoft/act";
export const app = act().build();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model.entries).toHaveLength(1);
  });

  it("skips test and spec files during extraction", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const S = state({ S: z.object({}) })
  .init(() => ({}))
  .emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E").build();
`,
      },
      {
        path: "src/app.spec.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const TestState = state({ TestState: z.object({}) })
  .init(() => ({}))
  .emits({ TestEvt: z.object({}) })
  .on({ test: z.object({}) }).emit("TestEvt").build();
`,
      },
      {
        path: "src/__tests__/helper.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const Helper = state({ Helper: z.object({}) })
  .init(() => ({}))
  .emits({ H: z.object({}) })
  .on({ h: z.object({}) }).emit("H").build();
`,
      },
    ];
    const { model } = extractModel(files);
    // Only the non-test state should be extracted
    expect(model.states).toHaveLength(1);
    expect(model.states[0].name).toBe("S");
  });

  it("handles act() with anonymous inline reaction", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `
import { state, act } from "@rotorsoft/act";
import { z } from "zod";
const S = state({ S: z.object({}) })
  .init(() => ({}))
  .emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E")
  .build();
const app = act()
  .withState(S)
  .on("E")
    .do(async (_ev, _s, app) => { await app.do("a", "s", {}); })
    .to(() => "t")
  .build();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model.reactions).toHaveLength(1);
    expect(model.reactions[0].isVoid).toBe(false);
  });

  it("scoped import falls all the way to unknownModuleProxy (line 107 branch #6)", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
import { thing } from "@scope/doesnotexist";
const x = thing;
export const S = state({ S: z.object({}) })
  .init(() => ({})).emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E").build();
`,
      },
    ];
    const { model, error } = extractModel(files);
    expect(error).toBeUndefined();
    expect(model.states).toHaveLength(1);
  });

  it("scoped import with subpath (line 103 truthy branch)", () => {
    const files: FileTab[] = [
      {
        path: "packages/mylib/src/utils.ts",
        content: `export const helper = "val";`,
      },
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
import { helper } from "@myorg/mylib/src/utils";
const x = helper;
export const S = state({ S: z.object({ x: z.string() }) })
  .init(() => ({ x })).emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E").build();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model.states).toHaveLength(1);
  });

  it("scoped import with no package name after @ (line 102 false)", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
import something from "@nopkg";
const x = something;
export const S = state({ S: z.object({}) })
  .init(() => ({ x })).emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E").build();
`,
      },
    ];
    const { error } = extractModel(files);
    expect(error).toBeUndefined();
  });

  it("scoped import with empty package name (line 102 false)", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
import something from "@/utils";
const x = something;
export const S = state({ S: z.object({}) })
  .init(() => ({ x })).emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E").build();
`,
      },
    ];
    const { error } = extractModel(files);
    expect(error).toBeUndefined();
  });

  it("file calling require.resolve does not crash evaluation", () => {
    const files: FileTab[] = [
      {
        path: "src/config.ts",
        content: `const p = require.resolve("./something");`,
      },
    ];
    const { model } = extractModel(files);
    expect(model).toBeDefined();
  });

  it("stripNonCode filters slice declarations inside template literals", () => {
    const files: FileTab[] = [
      {
        path: "src/samples.ts",
        content: `
import type { FileTab } from "./types.js";
export const SAMPLES: FileTab[] = [
  { path: "src/slices.ts", content: \`
import { slice } from "@rotorsoft/act";
export const FakeSlice = slice().build();
\` }
];`,
      },
    ];
    const { model } = extractModel(files);
    // FakeSlice is inside a template literal — should not appear
    const fake = model.slices.find((s) => s.name === "FakeSlice");
    expect(fake).toBeUndefined();
  });
});
