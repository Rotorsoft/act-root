import { describe, expect, it } from "vitest";
import { navigateToCode } from "../src/client/lib/navigate.js";
import type { FileTab } from "../src/client/types/file-tab.js";

const SAMPLE_FILES: FileTab[] = [
  {
    path: "src/states.ts",
    content: `import { state } from "@rotorsoft/act";
import { z } from "zod";

const mustBeOpen = {
  description: "Ticket must be open",
  valid: (state: any) => state.status === "open",
};

export const Ticket = state({ Ticket: z.object({
  title: z.string(),
  status: z.string(),
}) })
  .init(() => ({ title: "", status: "new" }))
  .emits({
    TicketOpened: z.object({ title: z.string() }),
    TicketClosed: z.object({ reason: z.string() }),
  })
  .on({ OpenTicket: z.object({ title: z.string() }) })
    .emit("TicketOpened")
  .on({ CloseTicket: z.object({ reason: z.string() }) })
    .given([mustBeOpen])
    .emit("TicketClosed")
  .build();`,
  },
  {
    path: "src/slices.ts",
    content: `import { slice } from "@rotorsoft/act";
import { Ticket } from "./states.js";

export const TicketSlice = slice()
  .withState(Ticket)
  .on("TicketOpened")
    .do(async function autoAssign(event, _stream, app) {
      await app.do("AssignTicket", event.stream, {}, event);
    })
    .to(() => "default")
  .build();`,
  },
  {
    path: "src/proj.ts",
    content: `import { projection } from "@rotorsoft/act";
import { z } from "zod";

export const TicketProjection = projection("tickets")
  .on({ TicketOpened: z.object({ title: z.string() }) })
    .do(async ({ stream }) => { console.log(stream); })
  .build();`,
  },
  {
    path: "src/app.ts",
    content: `import { act } from "@rotorsoft/act";
import { TicketSlice } from "./slices.js";

export const app = act()
  .withSlice(TicketSlice)
  .build();`,
  },
];

describe("navigateToCode", () => {
  it("finds a state definition", () => {
    const result = navigateToCode(SAMPLE_FILES, "Ticket", "state");
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/states.ts");
    expect(result!.line).toBeGreaterThan(0);
  });

  it("finds an action definition", () => {
    const result = navigateToCode(SAMPLE_FILES, "OpenTicket", "action");
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/states.ts");
  });

  it("finds an event definition", () => {
    const result = navigateToCode(SAMPLE_FILES, "TicketOpened", "event");
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/states.ts");
  });

  it("finds a reaction handler", () => {
    const result = navigateToCode(SAMPLE_FILES, "autoAssign", "reaction");
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/slices.ts");
  });

  it("finds a projection by variable name", () => {
    const result = navigateToCode(
      SAMPLE_FILES,
      "TicketProjection",
      "projection"
    );
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/proj.ts");
  });

  it("finds a projection by string name", () => {
    const result = navigateToCode(SAMPLE_FILES, "tickets", "projection");
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/proj.ts");
  });

  it("finds a guard/invariant by description", () => {
    const result = navigateToCode(SAMPLE_FILES, "Ticket must be open", "guard");
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/states.ts");
  });

  it("finds guard by variable name", () => {
    const result = navigateToCode(SAMPLE_FILES, "mustBeOpen", "guard");
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/states.ts");
  });

  it("navigates to a file with act() call", () => {
    const result = navigateToCode(SAMPLE_FILES, "src/app.ts", "file");
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/app.ts");
    expect(result!.line).toBeGreaterThan(1);
  });

  it("navigates to a file without act() — returns line 1", () => {
    const result = navigateToCode(SAMPLE_FILES, "src/states.ts", "file");
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/states.ts");
    expect(result!.line).toBe(1);
    expect(result!.col).toBe(1);
  });

  it("file navigation with partial path match", () => {
    const result = navigateToCode(SAMPLE_FILES, "app.ts", "file");
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/app.ts");
  });

  it("file navigation returns undefined for non-existent file", () => {
    expect(
      navigateToCode(SAMPLE_FILES, "nonexistent.ts", "file")
    ).toBeUndefined();
  });

  it("finds name within targetFile using event block priority", () => {
    const result = navigateToCode(
      SAMPLE_FILES,
      "TicketOpened",
      "event",
      "src/states.ts"
    );
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/states.ts");
  });

  it("finds name within targetFile using action block priority", () => {
    const result = navigateToCode(
      SAMPLE_FILES,
      "OpenTicket",
      "action",
      "src/states.ts"
    );
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/states.ts");
  });

  it("targetFile with no block match falls back to generic search", () => {
    const result = navigateToCode(
      SAMPLE_FILES,
      "Ticket",
      "state",
      "src/states.ts"
    );
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/states.ts");
  });

  it("targetFile with name not found returns undefined", () => {
    expect(
      navigateToCode(SAMPLE_FILES, "NonExistent", "event", "src/states.ts")
    ).toBeUndefined();
  });

  it("targetFile not in file list returns undefined", () => {
    expect(
      navigateToCode(SAMPLE_FILES, "Ticket", "state", "src/nonexistent.ts")
    ).toBeUndefined();
  });

  it("returns undefined for non-existent element", () => {
    expect(
      navigateToCode(SAMPLE_FILES, "DoesNotExist", "state")
    ).toBeUndefined();
  });

  it("generic search (no type) finds across all patterns", () => {
    const result = navigateToCode(SAMPLE_FILES, "TicketSlice");
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/slices.ts");
  });

  it("skips non-ts files in generic search", () => {
    const files: FileTab[] = [
      { path: "src/data.json", content: `{ "name": "Ticket" }` },
      {
        path: "src/s.ts",
        content: `import { state } from "@rotorsoft/act";
import { z } from "zod";
export const Ticket = state({ Ticket: z.object({}) }).init(() => ({})).emits({}).build();`,
      },
    ];
    const result = navigateToCode(files, "Ticket", "state");
    expect(result!.file).toBe("src/s.ts");
  });

  it("skips matches inside line comments", () => {
    const files: FileTab[] = [
      {
        path: "src/t.ts",
        content: `// state({ Commented: z.object({}) })
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const Real = state({ Real: z.object({}) }).init(() => ({})).emits({ D: z.object({}) }).on({ X: z.object({}) }).emit("D").build();`,
      },
    ];
    expect(navigateToCode(files, "Commented", "state")).toBeUndefined();
  });

  it("skips matches inside block comments", () => {
    const files: FileTab[] = [
      {
        path: "src/t.ts",
        content: `/* state({ InBlock: z.object({}) }) */
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const R = state({ R: z.object({}) }).init(() => ({})).emits({ D: z.object({}) }).on({ X: z.object({}) }).emit("D").build();`,
      },
    ];
    expect(navigateToCode(files, "InBlock", "state")).toBeUndefined();
  });

  it("skips matches inside multi-line block comments", () => {
    const files: FileTab[] = [
      {
        path: "src/t.ts",
        content: `/**
 * state({ InJSDoc: z.object({}) })
 */
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const R = state({ R: z.object({}) }).init(() => ({})).emits({}).build();`,
      },
    ];
    expect(navigateToCode(files, "InJSDoc", "state")).toBeUndefined();
  });

  it("skips matches inside unclosed block comment (line not starting with *)", () => {
    // The line with "Hidden" doesn't start with * or //, so isInsideComment
    // must detect it via the unclosed block comment check (lines 30-33)
    const files: FileTab[] = [
      {
        path: "src/t.ts",
        content: `import { state } from "@rotorsoft/act";
import { z } from "zod";
/* block comment start
state({ Hidden: z.object({}) })
end of comment */
export const R = state({ R: z.object({}) }).init(() => ({})).emits({}).build();`,
      },
    ];
    expect(navigateToCode(files, "Hidden", "state")).toBeUndefined();
  });

  it("finds match after a closed block comment (not inside comment)", () => {
    const files: FileTab[] = [
      {
        path: "src/t.ts",
        content: `/* this is a comment */
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const Found = state({ Found: z.object({}) }).init(() => ({})).emits({}).build();`,
      },
    ];
    const result = navigateToCode(files, "Found", "state");
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/t.ts");
    expect(result!.line).toBe(4);
  });

  it("handles match on the last line of file (no trailing newline)", () => {
    const files: FileTab[] = [
      {
        path: "src/t.ts",
        content: `import { state } from "@rotorsoft/act";
import { z } from "zod";
export const Foo = state({ Foo: z.object({}) }).init(() => ({})).emits({}).build();`,
      },
    ];
    const result = navigateToCode(files, "Foo", "state");
    expect(result).toBeDefined();
    expect(result!.line).toBe(3);
  });

  it("handles match at the very start of file (col 1)", () => {
    const files: FileTab[] = [
      {
        path: "src/t.ts",
        content: `const Foo = 1;`,
      },
    ];
    const result = navigateToCode(files, "Foo");
    expect(result).toBeDefined();
    expect(result!.line).toBe(1);
  });

  it("nameOffsetInMatch negative falls back to match.index", () => {
    // Use a pattern where the name is captured in a group but the full match
    // doesn't literally contain the name string (edge case with regex groups)
    const files: FileTab[] = [
      {
        path: "src/t.ts",
        content: `import { state } from "@rotorsoft/act";
import { z } from "zod";
const x = state({ X: z.object({}) }).init(() => ({})).emits({}).build();`,
      },
    ];
    // "X" is very short — lastIndexOf in the match will find it
    const result = navigateToCode(files, "X", "state");
    expect(result).toBeDefined();
  });

  it("guard navigation with targetFile finds const declaration (lines 195-215)", () => {
    const files: FileTab[] = [
      {
        path: "src/guards.ts",
        content: `import type { Invariant } from "@rotorsoft/act";

export const mustBeOpen: Invariant<{ status: string }> = {
  description: "Ticket must be open",
  valid: (state) => state.status === "open",
};

export const mustBeAssigned: Invariant<{ assignedTo: string }> = {
  description: "Must be assigned",
  valid: (state) => !!state.assignedTo,
};`,
      },
    ];
    const result = navigateToCode(
      files,
      "Ticket must be open",
      "guard",
      "src/guards.ts"
    );
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/guards.ts");
    // Should jump to the const declaration, not the description string
    expect(result!.line).toBe(3);
  });

  it("guard navigation with targetFile falls back to description when no const found (lines 213-215)", () => {
    const files: FileTab[] = [
      {
        path: "src/guards.ts",
        content: `// File with a description but no const declaration before it
{
  description: "Orphan guard desc",
  valid: () => true,
}`,
      },
    ];
    const result = navigateToCode(
      files,
      "Orphan guard desc",
      "guard",
      "src/guards.ts"
    );
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/guards.ts");
    // Falls back to the description position itself
    const lines = files[0].content.split("\n");
    const descLine =
      lines.findIndex((l) => l.includes("Orphan guard desc")) + 1;
    expect(result!.line).toBe(descLine);
  });

  it("guard general search fallback to description when no const declaration before it (lines 270-271)", () => {
    const files: FileTab[] = [
      {
        path: "src/inline.ts",
        content: `// An inline guard object without a preceding const declaration
{
  description: "Inline guard check",
  valid: (s: any) => s.active,
}`,
      },
    ];
    // No targetFile — uses general search path
    const result = navigateToCode(files, "Inline guard check", "guard");
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/inline.ts");
    // Should fall back to the description position
    const lines = files[0].content.split("\n");
    const descLine =
      lines.findIndex((l) => l.includes("Inline guard check")) + 1;
    expect(result!.line).toBe(descLine);
  });

  it("event navigation falls back to .emits() line when event name exists but not inline (lines 182-185)", () => {
    const files: FileTab[] = [
      {
        path: "src/states.ts",
        content: `import { state } from "@rotorsoft/act";
import { z } from "zod";
import { myEvents } from "./events.js";

export const Ticket = state({ Ticket: z.object({}) })
  .init(() => ({}))
  .emits(myEvents)
  .on({ OpenTicket: z.object({}) })
    .emit("TicketOpened")
  .build();

// TicketOpened is used elsewhere but not inside .emits({...}) block
const x = "TicketOpened";`,
      },
    ];
    const result = navigateToCode(
      files,
      "TicketOpened",
      "event",
      "src/states.ts"
    );
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/states.ts");
    // Should navigate to the .emits( line since event name exists in file but not in .emits({...}) block
    const emitsLine =
      files[0].content.split("\n").findIndex((l) => l.includes(".emits(")) + 1;
    expect(result!.line).toBe(emitsLine);
  });

  it("findNonCommentMatch skips commented match and returns non-commented one (line 52)", () => {
    // Exercises the false branch of isInsideComment check inside findNonCommentMatch
    const files: FileTab[] = [
      {
        path: "src/t.ts",
        content: `// .emits(commented)
.emits(real)
const TicketOpened = "event";`,
      },
    ];
    const result = navigateToCode(files, "TicketOpened", "event", "src/t.ts");
    expect(result).toBeDefined();
    // Should find .emits on line 2, not the commented one on line 1
    expect(result!.line).toBe(2);
  });

  it("event in targetFile: name exists but no .emits() call (line 183 false)", () => {
    const files: FileTab[] = [
      {
        path: "src/t.ts",
        content: `const TicketOpened = "some string";
// no .emits() call anywhere`,
      },
    ];
    const result = navigateToCode(files, "TicketOpened", "event", "src/t.ts");
    // Falls through to generic fallback search
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/t.ts");
    expect(result!.line).toBe(1);
  });

  it("guard in targetFile: description not found (line 194 false)", () => {
    const files: FileTab[] = [
      {
        path: "src/guards.ts",
        content: `export const myGuard = { valid: () => true };`,
      },
    ];
    const result = navigateToCode(
      files,
      "nonexistent description",
      "guard",
      "src/guards.ts"
    );
    expect(result).toBeUndefined();
  });

  it("action in targetFile: no .on() block (line 220 false)", () => {
    const files: FileTab[] = [
      {
        path: "src/t.ts",
        content: `const MyAction = "action defined somewhere";`,
      },
    ];
    const result = navigateToCode(files, "MyAction", "action", "src/t.ts");
    expect(result).toBeDefined();
    // Falls through to generic fallback
    expect(result!.line).toBe(1);
  });

  it("action in targetFile: action found after .on( (line 222 true)", () => {
    const files: FileTab[] = [
      {
        path: "src/t.ts",
        content: `const x = builder
  .on({ OtherAction: {} })
  .emit("Evt");
const MyAction = "declared later";`,
      },
    ];
    const result = navigateToCode(files, "MyAction", "action", "src/t.ts");
    expect(result).toBeDefined();
  });

  it("action in targetFile: action not after .on( (line 222 false)", () => {
    const files: FileTab[] = [
      {
        path: "src/t.ts",
        content: `const MyAction = "defined before on block";
const x = builder.on({ Other: {} }).emit("E");`,
      },
    ];
    const result = navigateToCode(files, "MyAction", "action", "src/t.ts");
    expect(result).toBeDefined();
    // Falls through to generic fallback (first non-comment occurrence)
    expect(result!.line).toBe(1);
  });

  it("generic search sorts test files after source files (line 246)", () => {
    const files: FileTab[] = [
      {
        path: "src/__tests__/helper.ts",
        content: `const MyThing = "in test folder";`,
      },
      {
        path: "src/app.spec.ts",
        content: `const MyThing = "in spec file";`,
      },
      {
        path: "src/app.ts",
        content: `const MyThing = "in source";`,
      },
    ];
    const result = navigateToCode(files, "MyThing");
    expect(result).toBeDefined();
    // Source file should be preferred over test file
    expect(result!.file).toBe("src/app.ts");
  });

  it("guard general search skips non-ts files (line 253)", () => {
    const files: FileTab[] = [
      {
        path: "src/data.json",
        content: `{ "description": "Some guard desc" }`,
      },
      {
        path: "src/guards.ts",
        content: `export const myGuard = {
  description: "Some guard desc",
  valid: (s: any) => s.ok,
};`,
      },
    ];
    const result = navigateToCode(files, "Some guard desc", "guard");
    expect(result).toBeDefined();
    // Should find it in .ts file, not .json
    expect(result!.file).toBe("src/guards.ts");
  });

  it("guard general search finds const declaration when present (lines 265-268)", () => {
    const files: FileTab[] = [
      {
        path: "src/guards.ts",
        content: `export const myGuard = {
  description: "Must be active",
  valid: (s: any) => s.active,
};`,
      },
    ];
    const result = navigateToCode(files, "Must be active", "guard");
    expect(result).toBeDefined();
    expect(result!.file).toBe("src/guards.ts");
    // Should navigate to the const declaration (line 1)
    expect(result!.line).toBe(1);
  });
});
