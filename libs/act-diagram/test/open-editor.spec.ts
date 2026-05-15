import { describe, expect, it } from "vitest";
import {
  editorArgs,
  openInEditor,
  pickEditor,
} from "../src/cli/open-editor.js";

describe("pickEditor", () => {
  it("uses the override when provided", () => {
    expect(pickEditor({}, "nano")).toBe("nano");
  });
  it("prefers VISUAL over EDITOR", () => {
    expect(pickEditor({ VISUAL: "nvim", EDITOR: "vi" })).toBe("nvim");
  });
  it("falls back to EDITOR", () => {
    expect(pickEditor({ EDITOR: "code" })).toBe("code");
  });
  it("defaults to vi when nothing is set", () => {
    expect(pickEditor({})).toBe("vi");
  });
});

describe("editorArgs", () => {
  it("uses +N for vim-family editors", () => {
    expect(editorArgs("nvim", "/abs/path.ts", 42)).toEqual([
      "+42",
      "/abs/path.ts",
    ]);
    expect(editorArgs("vim", "/abs/path.ts", 5)).toEqual([
      "+5",
      "/abs/path.ts",
    ]);
    expect(editorArgs("nano", "/abs/path.ts", 1)).toEqual([
      "+1",
      "/abs/path.ts",
    ]);
  });

  it("uses --goto file:line for VS Code / Cursor", () => {
    expect(editorArgs("code", "/abs/path.ts", 42)).toEqual([
      "--goto",
      "/abs/path.ts:42",
    ]);
    expect(editorArgs("code-insiders", "/abs/path.ts", 7)).toEqual([
      "--goto",
      "/abs/path.ts:7",
    ]);
    expect(editorArgs("cursor", "/abs/path.ts", 9)).toEqual([
      "--goto",
      "/abs/path.ts:9",
    ]);
    expect(
      editorArgs(
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
        "/p.ts",
        3
      )
    ).toEqual(["--goto", "/p.ts:3"]);
  });

  it("omits the line when none is provided", () => {
    expect(editorArgs("nvim", "/abs/path.ts", undefined)).toEqual([
      "/abs/path.ts",
    ]);
    expect(editorArgs("code", "/abs/path.ts", undefined)).toEqual([
      "/abs/path.ts",
    ]);
  });
});

describe("openInEditor", () => {
  it("reports failure when the editor binary doesn't exist", async () => {
    const result = await openInEditor("foo.ts", 12, {
      rootDir: "/tmp",
      editor: "definitely-not-a-real-editor-1729",
      stdio: "ignore",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("reports success when the editor exits 0", async () => {
    // `true` exits 0 immediately, available on every POSIX system.
    const result = await openInEditor("foo.ts", undefined, {
      rootDir: "/tmp",
      editor: "true",
      stdio: "ignore",
    });
    expect(result.ok).toBe(true);
  });

  it("reports failure when the editor exits non-zero", async () => {
    const result = await openInEditor("foo.ts", undefined, {
      rootDir: "/tmp",
      editor: "false",
      stdio: "ignore",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exit/);
  });
});
