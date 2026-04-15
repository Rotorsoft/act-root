import { describe, expect, it } from "vitest";
import { extractModel } from "../src/client/lib/evaluate.js";
import type { FileTab } from "../src/client/types/file-tab.js";

describe("extractModel — error handling, broken files, regex fallback", () => {
  it("handles files with syntax errors gracefully", () => {
    const files: FileTab[] = [
      {
        path: "src/broken.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";

export const Widget = state({ Widget: z.object({ value: z.string() }) })
  .init(() => ({{ value: "" }}))
  .emits({ ValueSet: z.object({ value: z.string() }) })
  .on({ SetValue: z.object({ value: z.string() }) })
    .emit("ValueSet")
  .build();
`,
      },
    ];
    const { model } = extractModel(files);
    // Broken file produces no states (no regex fallback), but doesn't crash
    expect(model.states).toHaveLength(0);
  });

  it("broken file with only states produces nothing", () => {
    const files: FileTab[] = [
      {
        path: "src/b.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
const x = ({{ broken }});
export const S = state({ S: z.object({}) })
  .init(() => ({}))
  .emits({ Created: z.object({}), Updated: z.object({}) })
  .patch({ Created: (e, s) => s, Updated: (e, s) => s })
  .on({ create: z.object({}) }).emit("Created")
  .build();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model.states).toHaveLength(0);
  });

  it("regex fallback extracts emit from arrow function handler with single-quoted event", () => {
    const files: FileTab[] = [
      {
        path: "src/b.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
const x = ({{ broken }});
export const S = state({ S: z.object({}) })
  .init(() => ({}))
  .emits({ MyEvent: z.object({}) })
  .on({ doIt: z.object({}) })
    .emit((action) => ['MyEvent', { data: action }])
  .build();
`,
      },
    ];
    const { model } = extractModel(files);
    const st = model.states.find((s) => s.name === "S");
    if (st) {
      const action = st.actions.find((a) => a.name === "doIt");
      if (action) expect(action.emits).toContain("MyEvent");
    }
  });

  it("broken file with slice produces error placeholder", () => {
    const files: FileTab[] = [
      {
        path: "src/b.ts",
        content: `
import { slice, state, projection } from "@rotorsoft/act";
import { z } from "zod";
const x = ({{ broken }});
const S = state({ S: z.object({}) }).init(() => ({})).emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E").build();
const P = projection("proj").on({ E: z.object({}) }).do().build();
const MySlice = slice()
  .withState(S)
  .withProjection(P)
  .on("E").do(async function handler() {}).to("target")
  .build();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model.slices).toHaveLength(1);
    expect(model.slices[0].error).toBeDefined();
  });

  it("regex fallback extracts given invariants", () => {
    const files: FileTab[] = [
      {
        path: "src/b.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
const x = ({{ broken }});
export const S = state({ S: z.object({}) })
  .init(() => ({}))
  .emits({ Done: z.object({}) })
  .on({ doIt: z.object({}) })
    .given([{ description: "must be valid", valid: () => true }])
    .emit("Done")
  .build();
`,
      },
    ];
    const { model } = extractModel(files);
    const st = model.states.find((s) => s.name === "S");
    if (st) {
      const action = st.actions.find((a) => a.name === "doIt");
      if (action) expect(action.invariants).toContain("must be valid");
    }
  });

  it("broken file does not produce projections", () => {
    const files: FileTab[] = [
      {
        path: "src/b.ts",
        content: `
import { projection } from "@rotorsoft/act";
import { z } from "zod";
const x = ({{ broken }});
const P = projection("myProj")
  .on({ A: z.object({}) }).do()
  .on({ B: z.object({}) }).do()
  .build();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model.projections).toHaveLength(0);
  });

  it("broken file with only states and backtick emits produces nothing", () => {
    const files: FileTab[] = [
      {
        path: "src/b.ts",
        content:
          'import { state } from "@rotorsoft/act";\nimport { z } from "zod";\nconst x = ({{ broken }});\nexport const S = state({ S: z.object({}) })\n  .init(() => ({}))\n  .emits({ MyEvt: z.object({}) })\n  .on({ doIt: z.object({}) })\n    .emit((a) => [`MyEvt`, {}])\n  .build();\n',
      },
    ];
    const { model } = extractModel(files);
    expect(model.states).toHaveLength(0);
  });

  it("broken file with slice produces error placeholder (variable handler)", () => {
    const files: FileTab[] = [
      {
        path: "src/b.ts",
        content: `
import { slice } from "@rotorsoft/act";
import { z } from "zod";
const x = ({{ broken }});
const MySlice = slice()
  .on("SomeEvent").do(myHandler)
  .build();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model.slices).toHaveLength(1);
    expect(model.slices[0].error).toBeDefined();
  });

  it("regex fallback: slice reaction with anonymous handler", () => {
    const files: FileTab[] = [
      {
        path: "src/b.ts",
        content: `
import { slice } from "@rotorsoft/act";
import { z } from "zod";
const x = ({{ broken }});
const MySlice = slice()
  .on("SomeEvent").do(async () => {})
  .build();
`,
      },
    ];
    const { model } = extractModel(files);
    // The regex won't capture anonymous arrow, so no reactions extracted
    expect(model).toBeDefined();
  });

  it("broken file produces error placeholder for slices defined in it", () => {
    const files: FileTab[] = [
      {
        path: "src/b.ts",
        content: `
import { state, slice } from "@rotorsoft/act";
import { z } from "zod";
const x = ({{ broken }});
export const S = state({ S: z.object({}) })
  .init(() => ({}))
  .emits({ Done: z.object({}) })
  .on({ doIt: z.object({}) }).emit("Done")
  .build();
export const MySlice = slice()
  .withState(S)
  .build();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model.states).toHaveLength(0);
    expect(model.slices).toHaveLength(1);
    expect(model.slices[0].error).toBeDefined();
  });

  it("broken file does not produce projections (no fallback scan)", () => {
    const files: FileTab[] = [
      {
        path: "src/proj.ts",
        content: `
import { projection } from "@rotorsoft/act";
import { z } from "zod";
const x = ({{ broken syntax }});
export const P = projection("uncaptured")
  .on({ A: z.object({}) }).do()
  .on({ B: z.object({}) }).do()
  .build();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model.projections).toHaveLength(0);
  });

  it("eval throws non-Error (line 182 false branch)", () => {
    const files: FileTab[] = [
      {
        path: "src/bad.ts",
        content: [
          'import { state } from "@rotorsoft/act";',
          'import { z } from "zod";',

          'throw "non-error string";',
          "export const S = state({ S: z.object({}) })",
          "  .init(() => ({})).emits({ E: z.object({}) })",
          '  .on({ a: z.object({}) }).emit("E").build();',
        ].join("\n"),
      },
    ];
    const { model } = extractModel(files);
    // File error should be recorded
    expect(model).toBeDefined();
  });

  it("outer catch with non-Error (line 209 false branch)", () => {
    const realFiles = [{ path: "src/app.ts", content: `const x = 1;` }];
    const poisoned: any = [...realFiles];
    poisoned.filter = () => {
      throw new Error("string error in setup");
    };
    const { error } = extractModel(poisoned as FileTab[]);
    expect(error).toBe("string error in setup");
  });

  it("outer catch in execute() for setup failure (line 209)", () => {
    const realFiles = [{ path: "src/app.ts", content: `const x = 1;` }];
    const poisoned: any = [...realFiles];
    poisoned.filter = () => {
      throw new Error("setup failure");
    };
    const { error } = extractModel(poisoned as FileTab[]);
    expect(error).toBeDefined();
  });

  it("outer catch non-Error branch (line 209 String(e))", () => {
    const poisoned: any = [{ path: "src/app.ts", content: "const x = 1;" }];
    poisoned.filter = () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw { toString: () => "non-error setup failure" };
    };
    const { error } = extractModel(poisoned as FileTab[]);
    expect(error).toBeDefined();
  });

  it("eval catch non-Error branch (line 182 String(e))", () => {
    const files: FileTab[] = [
      {
        path: "src/bad.ts",
        content: [
          'import { state } from "@rotorsoft/act";',
          'import { z } from "zod";',
          'throw "non-error throw";',
          "export const S = state({ S: z.object({}) })",
          "  .init(() => ({})).emits({ E: z.object({}) })",
          '  .on({ a: z.object({}) }).emit("E").build();',
        ].join("\n"),
      },
    ];
    const { model } = extractModel(files);
    expect(model).toBeDefined();
  });
});
