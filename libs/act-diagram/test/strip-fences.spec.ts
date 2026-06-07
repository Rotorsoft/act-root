import { describe, expect, it } from "vitest";
import {
  derive_project_name,
  parse_multi_file_response,
  strip_fences,
} from "../src/client/lib/strip-fences.js";

describe("parse_multi_file_response", () => {
  it("parses path-annotated fenced blocks", () => {
    const raw = `\`\`\`typescript:src/states.ts
import { state } from "@rotorsoft/act";
const x = 1;
\`\`\`

\`\`\`typescript:src/app.ts
import { act } from "@rotorsoft/act";
const app = act().build();
\`\`\``;

    const files = parse_multi_file_response(raw);
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

    const files = parse_multi_file_response(raw);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/app.ts");
  });

  it("falls back to single file when no path annotations", () => {
    const raw = `\`\`\`typescript
import { state } from "@rotorsoft/act";
\`\`\``;

    const files = parse_multi_file_response(raw);
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

    const files = parse_multi_file_response(raw);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/real.ts");
  });

  it("returns empty for empty input", () => {
    expect(parse_multi_file_response("")).toEqual([]);
  });

  it("returns empty for whitespace-only input", () => {
    expect(parse_multi_file_response("   \n  ")).toEqual([]);
  });

  it("treats non-code text as single fallback file", () => {
    const files = parse_multi_file_response("just some text");
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/app.ts");
  });
});

describe("strip_fences", () => {
  it("removes markdown fences", () => {
    const input = "```typescript\nimport { z } from 'zod';\n```";
    const result = strip_fences(input);
    expect(result).toBe("import { z } from 'zod';");
  });

  it("strips leading natural language before code", () => {
    const input =
      "Here is the code:\n\n```typescript\nimport { z } from 'zod';\n```";
    const result = strip_fences(input);
    expect(result).toBe("import { z } from 'zod';");
  });

  it("strips trailing natural language after code", () => {
    const input =
      "```typescript\nimport { z } from 'zod';\n```\n\nThis code does something.";
    const result = strip_fences(input);
    expect(result).toBe("import { z } from 'zod';");
  });

  it("handles code starting with JSDoc comment", () => {
    const input = "Some text before\n/** JSDoc */\nconst x = 1;";
    const result = strip_fences(input);
    expect(result).toContain("/** JSDoc */");
  });

  it("handles code starting with line comment", () => {
    const input = "Text before\n// comment\nconst x = 1;";
    const result = strip_fences(input);
    expect(result).toContain("// comment");
  });

  it("handles code starting with export", () => {
    const input = "Text\nexport const x = 1;";
    const result = strip_fences(input);
    expect(result).toContain("export const x = 1;");
  });

  it("handles code starting with type/interface/function", () => {
    expect(strip_fences("Text\ntype X = string;")).toContain("type X");
    expect(strip_fences("Text\ninterface Y {}")).toContain("interface Y");
    expect(strip_fences("Text\nfunction foo() {}")).toContain("function foo");
  });

  it("handles code with block comment endings", () => {
    const input = "```typescript\n/** doc */\nconst x = 1;\n```";
    const result = strip_fences(input);
    expect(result).toContain("const x = 1;");
  });

  it("strips trailing lines that don't look like code", () => {
    const input = "import { z } from 'zod';\nconst x = 1;\n\nHope this helps!";
    const result = strip_fences(input);
    expect(result).not.toContain("Hope this helps");
  });

  it("preserves lines ending with code-like tokens", () => {
    const code = "const x = {\n  a: 1,\n  b: 2\n};";
    expect(strip_fences(code)).toContain("};");
  });

  it("handles empty code block", () => {
    const input = "```typescript\n```";
    const result = strip_fences(input);
    expect(result).toBe("");
  });
});

describe("derive_project_name", () => {
  it("derives name from act() variable", () => {
    expect(derive_project_name("test", "const myApp = act()")).toBe("myApp");
  });

  it("derives name from state name", () => {
    expect(derive_project_name("test", "state({ Widget: z.object({}) })")).toBe(
      "Widget App"
    );
  });

  it("falls back to prompt words", () => {
    expect(derive_project_name("build a ticket system")).toBe(
      "Build Ticket System"
    );
  });

  it("returns default for empty prompt", () => {
    expect(derive_project_name("")).toBe("Generated App");
  });

  it("filters short words from prompt", () => {
    expect(derive_project_name("a b c do it now")).toBe("Now");
  });

  it("takes only first 3 meaningful words", () => {
    expect(
      derive_project_name("create a complex event sourcing application")
    ).toBe("Create Complex Event");
  });

  it("handles code without act() or state()", () => {
    expect(derive_project_name("test prompt", "const x = 1;")).toBe(
      "Test Prompt"
    );
  });
});
