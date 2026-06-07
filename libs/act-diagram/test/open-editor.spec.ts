import { describe, expect, it } from "vitest";
import {
  editor_args,
  open_in_editor,
  pick_editor,
} from "../src/cli/open-editor.js";

describe("pick_editor", () => {
  it("uses the override when provided", () => {
    expect(pick_editor({}, "nano")).toBe("nano");
  });
  it("prefers VISUAL over EDITOR", () => {
    expect(pick_editor({ VISUAL: "nvim", EDITOR: "vi" })).toBe("nvim");
  });
  it("falls back to EDITOR", () => {
    expect(pick_editor({ EDITOR: "code" })).toBe("code");
  });
  it("defaults to vi when nothing is set", () => {
    expect(pick_editor({})).toBe("vi");
  });
});

describe("editor_args", () => {
  it("uses +N for vim-family editors", () => {
    expect(editor_args("nvim", "/abs/path.ts", 42)).toEqual([
      "+42",
      "/abs/path.ts",
    ]);
    expect(editor_args("vim", "/abs/path.ts", 5)).toEqual([
      "+5",
      "/abs/path.ts",
    ]);
    expect(editor_args("nano", "/abs/path.ts", 1)).toEqual([
      "+1",
      "/abs/path.ts",
    ]);
  });

  it("uses --goto file:line for VS Code / Cursor", () => {
    expect(editor_args("code", "/abs/path.ts", 42)).toEqual([
      "--goto",
      "/abs/path.ts:42",
    ]);
    expect(editor_args("code-insiders", "/abs/path.ts", 7)).toEqual([
      "--goto",
      "/abs/path.ts:7",
    ]);
    expect(editor_args("cursor", "/abs/path.ts", 9)).toEqual([
      "--goto",
      "/abs/path.ts:9",
    ]);
    expect(
      editor_args(
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
        "/p.ts",
        3
      )
    ).toEqual(["--goto", "/p.ts:3"]);
  });

  it("omits the line when none is provided", () => {
    expect(editor_args("nvim", "/abs/path.ts", undefined)).toEqual([
      "/abs/path.ts",
    ]);
    expect(editor_args("code", "/abs/path.ts", undefined)).toEqual([
      "/abs/path.ts",
    ]);
  });
});

describe("open_in_editor", () => {
  it("reports failure when the editor binary doesn't exist", async () => {
    const result = await open_in_editor("foo.ts", 12, {
      root_dir: "/tmp",
      editor: "definitely-not-a-real-editor-1729",
      stdio: "ignore",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("reports success when the editor exits 0", async () => {
    // `true` exits 0 immediately, available on every POSIX system.
    const result = await open_in_editor("foo.ts", undefined, {
      root_dir: "/tmp",
      editor: "true",
      stdio: "ignore",
    });
    expect(result.ok).toBe(true);
  });

  it("reports failure when the editor exits non-zero", async () => {
    const result = await open_in_editor("foo.ts", undefined, {
      root_dir: "/tmp",
      editor: "false",
      stdio: "ignore",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exit/);
  });
});
