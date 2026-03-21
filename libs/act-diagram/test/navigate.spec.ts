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
});
