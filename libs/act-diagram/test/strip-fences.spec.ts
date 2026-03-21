import { describe, expect, it } from "vitest";
import {
  deriveProjectName,
  parseMultiFileResponse,
  stripFences,
} from "../src/client/lib/strip-fences.js";

describe("parseMultiFileResponse", () => {
  it("parses path-annotated fenced blocks", () => {
    const raw = `\`\`\`typescript:src/states.ts
import { state } from "@rotorsoft/act";
const x = 1;
\`\`\`

\`\`\`typescript:src/app.ts
import { act } from "@rotorsoft/act";
const app = act().build();
\`\`\``;

    const files = parseMultiFileResponse(raw);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("src/states.ts");
    expect(files[0].content).toContain("state");
    expect(files[1].path).toBe("src/app.ts");
    expect(files[1].content).toContain("act");
  });

  it("parses ts shorthand annotations", () => {
    const raw = `\`\`\`ts:src/app.ts
const x = 1;
\`\`\``;

    const files = parseMultiFileResponse(raw);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/app.ts");
  });

  it("falls back to single file when no path annotations", () => {
    const raw = `\`\`\`typescript
import { state } from "@rotorsoft/act";
\`\`\``;

    const files = parseMultiFileResponse(raw);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/app.ts");
  });

  it("skips blocks with empty path or empty content", () => {
    const raw = `\`\`\`typescript:
empty path above
\`\`\`

\`\`\`typescript:src/real.ts
import { z } from "zod";
\`\`\`

\`\`\`typescript:src/empty.ts
\`\`\``;

    const files = parseMultiFileResponse(raw);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/real.ts");
  });

  it("returns empty for empty input", () => {
    expect(parseMultiFileResponse("")).toEqual([]);
  });

  it("returns empty for whitespace-only input", () => {
    expect(parseMultiFileResponse("   \n  ")).toEqual([]);
  });

  it("treats non-code text as single fallback file", () => {
    const files = parseMultiFileResponse("just some text");
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/app.ts");
  });
});

describe("stripFences", () => {
  it("removes markdown fences", () => {
    const input = "```typescript\nimport { z } from 'zod';\n```";
    const result = stripFences(input);
    expect(result).toBe("import { z } from 'zod';");
  });

  it("strips leading natural language before code", () => {
    const input =
      "Here is the code:\n\n```typescript\nimport { z } from 'zod';\n```";
    const result = stripFences(input);
    expect(result).toBe("import { z } from 'zod';");
  });

  it("strips trailing natural language after code", () => {
    const input =
      "```typescript\nimport { z } from 'zod';\n```\n\nThis code does something.";
    const result = stripFences(input);
    expect(result).toBe("import { z } from 'zod';");
  });

  it("handles code starting with JSDoc comment", () => {
    const input = "Some text before\n/** JSDoc */\nconst x = 1;";
    const result = stripFences(input);
    expect(result).toContain("/** JSDoc */");
  });

  it("handles code starting with line comment", () => {
    const input = "Text before\n// comment\nconst x = 1;";
    const result = stripFences(input);
    expect(result).toContain("// comment");
  });

  it("handles code starting with export", () => {
    const input = "Text\nexport const x = 1;";
    const result = stripFences(input);
    expect(result).toContain("export const x = 1;");
  });

  it("handles code starting with type/interface/function", () => {
    expect(stripFences("Text\ntype X = string;")).toContain("type X");
    expect(stripFences("Text\ninterface Y {}")).toContain("interface Y");
    expect(stripFences("Text\nfunction foo() {}")).toContain("function foo");
  });

  it("handles code with block comment endings", () => {
    const input = "```typescript\n/** doc */\nconst x = 1;\n```";
    const result = stripFences(input);
    expect(result).toContain("const x = 1;");
  });

  it("strips trailing lines that don't look like code", () => {
    const input = "import { z } from 'zod';\nconst x = 1;\n\nHope this helps!";
    const result = stripFences(input);
    expect(result).not.toContain("Hope this helps");
  });

  it("preserves lines ending with code-like tokens", () => {
    const code = "const x = {\n  a: 1,\n  b: 2\n};";
    expect(stripFences(code)).toContain("};");
  });

  it("handles empty code block", () => {
    const input = "```typescript\n```";
    const result = stripFences(input);
    expect(result).toBe("");
  });
});

describe("deriveProjectName", () => {
  it("derives name from act() variable", () => {
    expect(deriveProjectName("test", "const myApp = act()")).toBe("myApp");
  });

  it("derives name from state name", () => {
    expect(deriveProjectName("test", "state({ Widget: z.object({}) })")).toBe(
      "Widget App"
    );
  });

  it("falls back to prompt words", () => {
    expect(deriveProjectName("build a ticket system")).toBe(
      "Build Ticket System"
    );
  });

  it("returns default for empty prompt", () => {
    expect(deriveProjectName("")).toBe("Generated App");
  });

  it("filters short words from prompt", () => {
    expect(deriveProjectName("a b c do it now")).toBe("Now");
  });

  it("takes only first 3 meaningful words", () => {
    expect(
      deriveProjectName("create a complex event sourcing application")
    ).toBe("Create Complex Event");
  });

  it("handles code without act() or state()", () => {
    expect(deriveProjectName("test prompt", "const x = 1;")).toBe(
      "Test Prompt"
    );
  });
});
