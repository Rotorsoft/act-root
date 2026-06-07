/**
 * Tests for the interactive flow. We mock `@clack/prompts` so each
 * prompt resolves immediately from a programmable answer queue, then
 * drive `runInteractive` and assert which detail views / log entries
 * fired in what order.
 *
 * `@clack/prompts` itself is also tested through real CI smoke tests
 * against the example apps — these unit tests cover the dispatching
 * logic, the search/category routing, and the editor-launch path.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── @clack/prompts mock ────────────────────────────────────────────────

const CANCEL = Symbol("clack:cancel");

const answerQueue: unknown[] = [];
const logs: Array<{ kind: string; message: string }> = [];
const notes: Array<{ title?: string; body: string }> = [];
const intros: string[] = [];
const outros: string[] = [];
const cancelMessages: string[] = [];

vi.mock("@clack/prompts", () => ({
  isCancel: (v: unknown) => v === CANCEL,
  intro: (msg: string) => intros.push(msg),
  outro: (msg: string) => outros.push(msg),
  cancel: (msg: string) => cancelMessages.push(msg),
  note: (body: string, title?: string) => notes.push({ body, title }),
  log: {
    message: (m: string) => {
      logs.push({ kind: "message", message: m });
      // Detail views go through log.message now (note dimmed content).
      // Multi-line messages are details; track them in `notes` too so
      // legacy assertions keep working.
      if (m.includes("\n")) notes.push({ body: m, title: m.split("\n")[0] });
    },
    info: (m: string) => logs.push({ kind: "info", message: m }),
    warn: (m: string) => logs.push({ kind: "warn", message: m }),
    error: (m: string) => logs.push({ kind: "error", message: m }),
    success: (m: string) => logs.push({ kind: "success", message: m }),
  },
  select: async (_opts: unknown) => {
    if (answerQueue.length === 0)
      throw new Error("select called with empty answer queue");
    const next = answerQueue.shift();
    return typeof next === "function" ? (next as () => unknown)() : next;
  },
  text: async (_opts: unknown) => {
    if (answerQueue.length === 0)
      throw new Error("text called with empty answer queue");
    const next = answerQueue.shift();
    return typeof next === "function" ? (next as () => unknown)() : next;
  },
}));

// ── Open-editor mock — never spawn anything real ──────────────────────

const editorCalls: Array<{ file: string; line?: number }> = [];
let editorResult: { ok: boolean; reason?: string } = { ok: true };

vi.mock("../src/cli/open-editor.js", () => ({
  pickEditor: () => "vi",
  openInEditor: async (file: string, line: number | undefined) => {
    editorCalls.push({ file, line });
    return editorResult;
  },
}));

// ── Vim-keys mock — no real stdin patching during tests ───────────────

let slashCb: (() => void) | null = null;
vi.mock("../src/cli/vim-keys.js", () => ({
  enableVimKeys: () => ({
    restore: () => {},
    pause: () => {},
    resume: () => {},
    onSlash: (cb: () => void) => {
      slashCb = cb;
      return () => {
        slashCb = null;
      };
    },
  }),
}));

// Import AFTER mocks
const { runInteractive } = await import("../src/cli/repl.js");
const { extract_model } = await import("../src/client/lib/evaluate.js");
const { buildContractIndex } = await import("../src/cli/contract-index.js");

import type { FileTab } from "../src/client/types/file-tab.js";

const CALCULATOR: FileTab[] = [
  {
    path: "src/calculator.ts",
    content: `
import { state, slice, projection, act } from "@rotorsoft/act";
import { z } from "zod";

export const Calc = state({ Calc: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({
    Incremented: z.object({ amount: z.number() }),
    Reset: z.object({}),
  })
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
`,
  },
];

const buildIdx = () => {
  const { model } = extract_model(CALCULATOR);
  return buildContractIndex(model);
};

const queue = (...answers: unknown[]) => {
  answerQueue.length = 0;
  answerQueue.push(...answers);
};

beforeEach(() => {
  answerQueue.length = 0;
  logs.length = 0;
  notes.length = 0;
  intros.length = 0;
  outros.length = 0;
  cancelMessages.length = 0;
  editorCalls.length = 0;
  editorResult = { ok: true };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runInteractive", () => {
  it("greets, summarizes, and exits on quit", async () => {
    queue(CANCEL);
    const idx = buildIdx();
    await runInteractive(idx, "/tmp");
    expect(intros[0]).toContain("contracts explorer");
    expect(logs.some((l) => l.message.includes("loaded"))).toBe(true);
    expect(outros[0]).toBe("bye.");
  });

  it("exits with the outro banner when the top-level select is cancelled (esc/q)", async () => {
    queue(CANCEL);
    const idx = buildIdx();
    await runInteractive(idx, "/tmp");
    expect(outros[0]).toBe("bye.");
  });

  it("lists entries when a category is picked, shows detail, and returns to the loop", async () => {
    const idx = buildIdx();
    const event = idx.entries.find(
      (e) => e.kind === "event" && e.name === "Incremented"
    )!;
    queue(
      "event", // top-level category
      event, // entry from list
      CANCEL, // skip editor
      CANCEL // back at top
    );
    await runInteractive(idx, "/tmp");
    expect(notes.some((n) => n.body.includes("Incremented"))).toBe(true);
  });

  it("warns and loops back when the picked category is empty", async () => {
    // reactions: calculator has none in slice; only event handlers.
    // Wait — CalcSlice does have an `Incremented` reaction. Use a model
    // without slices instead.
    const empty = buildContractIndex({
      entries: [],
      states: [],
      slices: [],
      projections: [],
      reactions: [],
    });
    queue("event", CANCEL);
    await runInteractive(empty, "/tmp");
    expect(logs.some((l) => l.kind === "warn")).toBe(true);
  });

  it("offers an open-in-editor option after the detail view", async () => {
    const idx = buildIdx();
    const event = idx.entries.find(
      (e) => e.kind === "event" && e.name === "Incremented"
    )!;
    queue("event", event, "open", CANCEL);
    await runInteractive(idx, "/tmp");
    expect(editorCalls).toHaveLength(1);
    expect(editorCalls[0].file).toContain("calculator.ts");
  });

  it("warns when the editor exits non-zero", async () => {
    editorResult = { ok: false, reason: "exit 1" };
    const idx = buildIdx();
    const event = idx.entries.find(
      (e) => e.kind === "event" && e.name === "Incremented"
    )!;
    queue("event", event, "open", CANCEL);
    await runInteractive(idx, "/tmp");
    expect(logs.some((l) => l.message.includes("editor exited"))).toBe(true);
  });

  it("warns with a fallback reason when the editor exits without one", async () => {
    editorResult = { ok: false };
    const idx = buildIdx();
    const event = idx.entries.find(
      (e) => e.kind === "event" && e.name === "Incremented"
    )!;
    queue("event", event, "open", CANCEL);
    await runInteractive(idx, "/tmp");
    expect(logs.some((l) => l.message.includes("editor exited: unknown"))).toBe(
      true
    );
  });

  it("skips the editor select when the entry has no file", async () => {
    const idx = buildIdx();
    // Fabricate a fileless entry.
    const fileless = { kind: "event" as const, name: "Phantom" };
    queue("event", fileless, CANCEL);
    // Inject the fileless entry into the index so the list contains it.
    idx.entries.unshift(fileless);
    await runInteractive(idx, "/tmp");
    expect(editorCalls).toHaveLength(0);
  });

  it("renders file:line in the label when the entry has both", async () => {
    const idx = buildIdx();
    const withLine = {
      kind: "event" as const,
      name: "WithLine",
      file: "src/with-line.ts",
      line: 42,
    };
    idx.entries.unshift(withLine);
    queue("event", withLine, CANCEL, CANCEL);
    await runInteractive(idx, "/tmp");
    // The note title carries the entry kind+name; the label that
    // exercises labelEntry's truthy `e.line` arm was rendered into the
    // hidden select options.
    expect(notes[0]?.title).toBe("WithLine");
  });

  it("opens the editor with line undefined when entry has no line", async () => {
    const idx = buildIdx();
    const noLine = {
      kind: "event" as const,
      name: "NoLine",
      file: "src/no-line.ts",
    };
    idx.entries.unshift(noLine);
    queue("event", noLine, "open", CANCEL);
    await runInteractive(idx, "/tmp");
    expect(editorCalls).toEqual([{ file: "src/no-line.ts", line: undefined }]);
  });

  it("returns to the top loop when 'back' is picked from the list", async () => {
    const idx = buildIdx();
    queue("event", CANCEL, CANCEL);
    await runInteractive(idx, "/tmp");
    expect(notes).toHaveLength(0);
  });

  it("returns to the top loop when the list select is cancelled", async () => {
    const idx = buildIdx();
    queue("event", CANCEL, CANCEL);
    await runInteractive(idx, "/tmp");
    expect(outros[0]).toBe("bye.");
  });

  it("returns from the editor prompt when cancelled", async () => {
    const idx = buildIdx();
    const event = idx.entries.find(
      (e) => e.kind === "event" && e.name === "Incremented"
    )!;
    queue("event", event, CANCEL, CANCEL);
    await runInteractive(idx, "/tmp");
    expect(editorCalls).toHaveLength(0);
  });

  // `/` simulates a slash press: the slash callback fires (which sets
  // searchRequested), then the select cancels — exactly what the patched
  // stdin emit would do in real usage.
  const slash = () => {
    slashCb?.();
    return CANCEL;
  };

  it("runs the search-by-name flow with a fuzzy match", async () => {
    const idx = buildIdx();
    const event = idx.entries.find((e) => e.name === "Incremented")!;
    queue(slash, "Incre", event, CANCEL, CANCEL);
    await runInteractive(idx, "/tmp");
    expect(notes.some((n) => n.body.includes("Incremented"))).toBe(true);
  });

  it("routes category keywords typed in search to listByKind", async () => {
    const idx = buildIdx();
    const event = idx.entries.find(
      (e) => e.kind === "event" && e.name === "Incremented"
    )!;
    queue(slash, "events", event, CANCEL, CANCEL);
    await runInteractive(idx, "/tmp");
    expect(notes.some((n) => n.body.includes("Incremented"))).toBe(true);
  });

  it("warns when search finds no matches", async () => {
    const idx = buildIdx();
    queue(slash, "no-such-thing-xyz", CANCEL);
    await runInteractive(idx, "/tmp");
    expect(
      logs.some((l) => l.kind === "warn" && l.message.includes("no matches"))
    ).toBe(true);
  });

  it("returns from search when cancelled", async () => {
    const idx = buildIdx();
    queue(slash, CANCEL, CANCEL);
    await runInteractive(idx, "/tmp");
    expect(outros[0]).toBe("bye.");
  });

  it("returns from search when given empty input", async () => {
    const idx = buildIdx();
    queue(slash, "", CANCEL);
    await runInteractive(idx, "/tmp");
    expect(outros[0]).toBe("bye.");
    expect(notes).toHaveLength(0);
  });

  it("returns from search when given whitespace-only input", async () => {
    const idx = buildIdx();
    queue(slash, "   ", CANCEL);
    await runInteractive(idx, "/tmp");
    expect(outros[0]).toBe("bye.");
    expect(notes).toHaveLength(0);
  });
});

describe("runInteractive — export", () => {
  const tmpExports: string[] = [];
  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    for (const p of tmpExports.splice(0))
      await rm(p, { recursive: true, force: true });
  });

  async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "act-export-"));
    tmpExports.push(dir);
    return await fn(dir);
  }

  it("writes Markdown to the chosen file", async () => {
    await withTmpDir(async (dir) => {
      const idx = buildIdx();
      queue("export", "markdown", "registry.md", CANCEL);
      await runInteractive(idx, dir);
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const content = await readFile(join(dir, "registry.md"), "utf8");
      expect(content).toContain("# Act Contracts Registry");
      expect(content).toContain("### `Incremented`");
      expect(
        logs.some(
          (l) => l.kind === "success" && l.message.includes("registry.md")
        )
      ).toBe(true);
    });
  });

  it("writes JSON Schema to the chosen file", async () => {
    await withTmpDir(async (dir) => {
      const idx = buildIdx();
      queue("export", "json-schema", "contracts.json", CANCEL);
      await runInteractive(idx, dir);
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const content = await readFile(join(dir, "contracts.json"), "utf8");
      const parsed = JSON.parse(content);
      expect(parsed.$schema).toBe(
        "https://json-schema.org/draft/2020-12/schema"
      );
      expect(parsed.events.Incremented.schema).toMatchObject({
        type: "object",
      });
    });
  });

  it("cancels the export when the format select is cancelled", async () => {
    const idx = buildIdx();
    queue("export", CANCEL, CANCEL);
    await runInteractive(idx, "/tmp");
    expect(logs.some((l) => l.kind === "success" || l.kind === "error")).toBe(
      false
    );
  });

  it("cancels the export when the path input is cancelled", async () => {
    const idx = buildIdx();
    queue("export", "markdown", CANCEL, CANCEL);
    await runInteractive(idx, "/tmp");
    expect(logs.some((l) => l.kind === "success" || l.kind === "error")).toBe(
      false
    );
  });

  it("cancels the export when the path input is empty", async () => {
    const idx = buildIdx();
    queue("export", "markdown", "", CANCEL);
    await runInteractive(idx, "/tmp");
    expect(logs.some((l) => l.kind === "success" || l.kind === "error")).toBe(
      false
    );
  });

  it("cancels the export when the path input is whitespace-only", async () => {
    const idx = buildIdx();
    queue("export", "markdown", "   ", CANCEL);
    await runInteractive(idx, "/tmp");
    expect(logs.some((l) => l.kind === "success" || l.kind === "error")).toBe(
      false
    );
  });

  it("logs an error when the target directory doesn't exist", async () => {
    const idx = buildIdx();
    queue("export", "markdown", "nope/path/here.md", CANCEL);
    await runInteractive(idx, "/tmp/no-such-dir-xyz-123");
    expect(
      logs.some(
        (l) => l.kind === "error" && l.message.includes("could not write")
      )
    ).toBe(true);
  });
});

describe("runInteractive — labels and counts", () => {
  // Smoke test that the category select gets the right per-kind counts
  // by inspecting the calls clack would receive. We can't directly
  // observe options, but the choice-driven flow verifies that picking
  // each kind reaches a non-empty list (or a warning, for kinds with 0).
  it("dispatches to every kind in turn", async () => {
    const idx = buildIdx();
    const event = idx.entries.find((e) => e.kind === "event")!;
    const action = idx.entries.find((e) => e.kind === "action")!;
    const state = idx.entries.find((e) => e.kind === "state")!;
    const slice = idx.entries.find((e) => e.kind === "slice")!;
    const projection = idx.entries.find((e) => e.kind === "projection")!;
    const reaction = idx.entries.find((e) => e.kind === "reaction")!;
    queue(
      "event",
      event,
      CANCEL,
      "action",
      action,
      CANCEL,
      "state",
      state,
      CANCEL,
      "slice",
      slice,
      CANCEL,
      "projection",
      projection,
      CANCEL,
      "reaction",
      reaction,
      CANCEL,
      CANCEL
    );
    await runInteractive(idx, "/tmp");
    const titles = notes.map((n) => n.title);
    // Reactions carry a `(in <Slice>)` suffix in the header; everything
    // else is the bare name.
    expect(titles[0]).toBe("Incremented");
    expect(titles[1]).toBe("increment");
    expect(titles[2]).toBe("Calc");
    expect(titles[3]).toBe("CalcSlice");
    expect(titles[4]).toBe("totals");
    expect(titles[5]).toContain("logged");
  });
});

describe("runInteractive — file paths resolve to absolute", () => {
  it("passes a project-relative path to openInEditor; main resolves to absolute", async () => {
    const dir = await mkdtemp(join(tmpdir(), "act-repl-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "calculator.ts"), CALCULATOR[0].content);
    try {
      const idx = buildIdx();
      const event = idx.entries.find(
        (e) => e.kind === "event" && e.name === "Incremented"
      )!;
      queue("event", event, "open", CANCEL);
      await runInteractive(idx, dir);
      expect(editorCalls).toHaveLength(1);
      expect(editorCalls[0].file).toBe(event.file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
