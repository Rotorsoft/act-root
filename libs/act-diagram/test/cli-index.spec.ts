import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main, parse_args } from "../src/cli/index.js";

const CALCULATOR_SOURCE = `
import { state, slice, projection, act } from "@rotorsoft/act";
import { z } from "zod";

export const Calc = state({ Calc: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({
    Incremented: z.object({ amount: z.number() }),
    Reset: z.object({}),
  })
  .patch({ Incremented: ({ data }, s) => ({ count: s.count + data.amount }) })
  .on({ increment: z.object({ by: z.number() }) })
    .emit("Incremented")
  .on({ reset: z.object({}) })
    .emit("Reset")
  .build();

export const CalcSlice = slice()
  .withState(Calc)
  .on("Incremented")
    .do(async function logged() {})
  .build();

export const Totals = projection("totals")
  .on({ Incremented: z.object({}) })
    .do(async () => {})
  .build();

export const calculator = act()
  .withSlice(CalcSlice)
  .withProjection(Totals)
  .build();
`;

function collect(stream: PassThrough): { read: () => string } {
  const chunks: string[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c.toString()));
  return { read: () => chunks.join("") };
}

describe("parse_args", () => {
  it("leaves cwd unset when no positional or --cwd given (main fills the default)", () => {
    expect(parse_args([])).toEqual({
      cwd: undefined,
      help: false,
      version: false,
      max_files: undefined,
      query: undefined,
      markdown: false,
      json_schema: false,
    });
  });

  it("reads -h / --help", () => {
    expect(parse_args(["-h"]).help).toBe(true);
    expect(parse_args(["--help"]).help).toBe(true);
  });

  it("reads -v / --version", () => {
    expect(parse_args(["-v"]).version).toBe(true);
    expect(parse_args(["--version"]).version).toBe(true);
  });

  it("reads --cwd <dir>", () => {
    expect(parse_args(["--cwd", "/tmp/x"]).cwd).toBe("/tmp/x");
  });

  it("takes a positional dir argument", () => {
    expect(parse_args(["some/dir"]).cwd).toBe("some/dir");
  });

  it("--cwd without a value leaves cwd unset (main fills the default)", () => {
    expect(parse_args(["--cwd"]).cwd).toBeUndefined();
  });

  it("reads --max-files <n>", () => {
    expect(parse_args(["--max-files", "10"]).max_files).toBe(10);
  });

  it("ignores invalid --max-files values", () => {
    expect(parse_args(["--max-files", "nope"]).max_files).toBeUndefined();
    expect(parse_args(["--max-files", "-3"]).max_files).toBeUndefined();
  });

  it("ignores --max-files with no value", () => {
    expect(parse_args(["--max-files"]).max_files).toBeUndefined();
  });

  it("ignores unknown flags", () => {
    expect(parse_args(["--unknown-flag"]).cwd).toBeUndefined();
  });

  it("reads -q / --query <name>", () => {
    expect(parse_args(["-q", "Foo"]).query).toBe("Foo");
    expect(parse_args(["--query", "Bar"]).query).toBe("Bar");
  });

  it("leaves query unset when -q has no value", () => {
    expect(parse_args(["-q"]).query).toBeUndefined();
  });

  it("reads -m / --markdown / --md", () => {
    expect(parse_args(["-m"]).markdown).toBe(true);
    expect(parse_args(["--markdown"]).markdown).toBe(true);
    expect(parse_args(["--md"]).markdown).toBe(true);
    expect(parse_args([]).markdown).toBe(false);
  });

  it("reads -j / --json-schema / --json", () => {
    expect(parse_args(["-j"]).json_schema).toBe(true);
    expect(parse_args(["--json-schema"]).json_schema).toBe(true);
    expect(parse_args(["--json"]).json_schema).toBe(true);
    expect(parse_args([]).json_schema).toBe(false);
  });
});

describe("main", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "act-contracts-cli-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "calculator.ts"), CALCULATOR_SOURCE);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("prints usage on --help and exits 0", async () => {
    const out = new PassThrough();
    const err = new PassThrough();
    const reader = collect(out);
    const code = await main({
      input: new PassThrough(),
      output: out,
      error_output: err,
      isTTY: false,
      argv: ["--help"],
      version_string: "test",
    });
    expect(code).toBe(0);
    expect(reader.read()).toContain("Usage:");
  });

  it("prints version on --version and exits 0", async () => {
    const out = new PassThrough();
    const reader = collect(out);
    const code = await main({
      input: new PassThrough(),
      output: out,
      error_output: new PassThrough(),
      isTTY: false,
      argv: ["--version"],
      version_string: "act-contracts test-1.2.3",
    });
    expect(code).toBe(0);
    expect(reader.read()).toContain("act-contracts test-1.2.3");
  });

  it("errors when no TypeScript sources are found", async () => {
    const empty = await mkdtemp(join(tmpdir(), "act-contracts-empty-"));
    try {
      const err = new PassThrough();
      const reader = collect(err);
      const code = await main({
        input: new PassThrough(),
        output: new PassThrough(),
        error_output: err,
        isTTY: false,
        argv: [empty],
        version_string: "test",
      });
      expect(code).toBe(1);
      expect(reader.read()).toContain("no TypeScript source files");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("warns when scan is truncated by --max-files", async () => {
    const big = await mkdtemp(join(tmpdir(), "act-cli-big-"));
    try {
      await mkdir(join(big, "src"), { recursive: true });
      for (let i = 0; i < 3; i++) {
        await writeFile(join(big, "src", `f${i}.ts`), "export const x = 1;");
      }
      const err = new PassThrough();
      const errReader = collect(err);
      // -q makes the flow non-interactive so the test doesn't hang.
      const code = await main({
        input: new PassThrough(),
        output: new PassThrough(),
        error_output: err,
        isTTY: false,
        argv: [big, "--max-files", "1", "-q", "anything"],
        version_string: "test",
      });
      // Truncated scan still emits the warning even if the query has no hits.
      expect([0, 1]).toContain(code);
      expect(errReader.read()).toContain("scan was truncated");
    } finally {
      await rm(big, { recursive: true, force: true });
    }
  });

  it("falls back to default_dir when no positional arg or --cwd is given", async () => {
    const out = new PassThrough();
    const outReader = collect(out);
    const code = await main({
      input: new PassThrough(),
      output: out,
      error_output: new PassThrough(),
      isTTY: false,
      argv: ["-q", "Incremented"],
      version_string: "test",
      default_dir: root,
    });
    expect(code).toBe(0);
    expect(outReader.read()).toContain("Incremented");
  });

  it("uses '.' when neither --cwd nor default_dir is provided", async () => {
    const empty = await mkdtemp(join(tmpdir(), "act-cli-defaultdir-"));
    const prevCwd = process.cwd();
    try {
      process.chdir(empty);
      const code = await main({
        input: new PassThrough(),
        output: new PassThrough(),
        error_output: new PassThrough(),
        isTTY: false,
        argv: [],
        version_string: "test",
      });
      expect(code).toBe(1);
    } finally {
      process.chdir(prevCwd);
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("prints the detail for an exact -q match", async () => {
    const out = new PassThrough();
    const outReader = collect(out);
    const code = await main({
      input: new PassThrough(),
      output: out,
      error_output: new PassThrough(),
      isTTY: false,
      argv: [root, "-q", "Incremented"],
      version_string: "test",
    });
    expect(code).toBe(0);
    const text = outReader.read();
    expect(text).toContain("Incremented");
    expect(text).toContain("z.object({ amount: z.number() })");
  });

  it("prints the match list when -q is ambiguous", async () => {
    // Add a second file so two entries share a name in different scopes.
    const ambiguous = await mkdtemp(join(tmpdir(), "act-cli-ambig-"));
    try {
      await mkdir(join(ambiguous, "src"), { recursive: true });
      await writeFile(
        join(ambiguous, "src", "a.ts"),
        CALCULATOR_SOURCE.replace(/Calc/g, "CalcA")
      );
      await writeFile(
        join(ambiguous, "src", "b.ts"),
        CALCULATOR_SOURCE.replace(/Calc/g, "CalcB")
      );
      const out = new PassThrough();
      const outReader = collect(out);
      const code = await main({
        input: new PassThrough(),
        output: out,
        error_output: new PassThrough(),
        isTTY: false,
        argv: [ambiguous, "-q", "Inc"],
        version_string: "test",
      });
      expect(code).toBe(0);
      expect(outReader.read()).toContain("matches");
    } finally {
      await rm(ambiguous, { recursive: true, force: true });
    }
  });

  it("prints detail for a single substring match with no exact hit", async () => {
    const out = new PassThrough();
    const outReader = collect(out);
    const code = await main({
      input: new PassThrough(),
      output: out,
      error_output: new PassThrough(),
      isTTY: false,
      argv: [root, "-q", "Tot"], // partial — only matches projection Totals
      version_string: "test",
    });
    expect(code).toBe(0);
    expect(outReader.read()).toContain("totals");
  });

  it("enters the interactive flow when no -q is given (via injected override)", async () => {
    let called = 0;
    const code = await main({
      input: new PassThrough(),
      output: new PassThrough(),
      error_output: new PassThrough(),
      isTTY: false,
      argv: [root],
      version_string: "test",
      run_interactive: async () => {
        called++;
      },
    });
    expect(code).toBe(0);
    expect(called).toBe(1);
  });

  it("falls through to the default run_interactive when no override is given", async () => {
    // Mock the repl module so the *real* `run_interactive` import inside
    // index.ts becomes a no-op. This exercises the `?? run_interactive`
    // arm without hanging on the clack prompts.
    vi.resetModules();
    let invoked = 0;
    vi.doMock("../src/cli/repl.js", () => ({
      run_interactive: async () => {
        invoked++;
      },
    }));
    const { main: mainFresh } = await import("../src/cli/index.js");
    const code = await mainFresh({
      input: new PassThrough(),
      output: new PassThrough(),
      error_output: new PassThrough(),
      isTTY: false,
      argv: [root],
      version_string: "test",
    });
    vi.doUnmock("../src/cli/repl.js");
    vi.resetModules();
    expect(code).toBe(0);
    expect(invoked).toBe(1);
  });

  it("emits a Markdown registry with --markdown", async () => {
    const out = new PassThrough();
    const reader = collect(out);
    const code = await main({
      input: new PassThrough(),
      output: out,
      error_output: new PassThrough(),
      isTTY: false,
      argv: [root, "--markdown"],
      version_string: "test",
    });
    expect(code).toBe(0);
    const text = reader.read();
    expect(text).toContain("# Act Contracts Registry");
    expect(text).toContain("## Events");
    expect(text).toContain("### `Incremented`");
  });

  it("emits JSON Schema with --json-schema", async () => {
    const out = new PassThrough();
    const reader = collect(out);
    const code = await main({
      input: new PassThrough(),
      output: out,
      error_output: new PassThrough(),
      isTTY: false,
      argv: [root, "--json-schema"],
      version_string: "test",
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(reader.read());
    expect(parsed.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(parsed.events.Incremented).toBeDefined();
    expect(parsed.events.Incremented.schema).toMatchObject({
      type: "object",
      properties: { amount: { type: "number" } },
    });
  });

  it("returns 1 with -q when no entity matches", async () => {
    const err = new PassThrough();
    const errReader = collect(err);
    const code = await main({
      input: new PassThrough(),
      output: new PassThrough(),
      error_output: err,
      isTTY: false,
      argv: [root, "-q", "no-such-event"],
      version_string: "test",
    });
    expect(code).toBe(1);
    expect(errReader.read()).toContain("no matches");
  });
});
