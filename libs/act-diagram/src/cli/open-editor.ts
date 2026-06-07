/**
 * Spawn the user's editor positioned at a specific file:line.
 *
 * Honors `$VISUAL` then `$EDITOR`; defaults to `vi` when neither is set.
 * Recognizes VS Code's `--goto` flag separately because `code +<line>`
 * doesn't work; everything else uses the classic `+<line> <file>` form
 * that vim, nvim, nano, and emacs all understand.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

export type EditorDeps = {
  /** Project root the file path is relative to. */
  root_dir: string;
  /** Override the editor command (mainly for tests). */
  editor?: string;
  /** Override stdio (mainly for tests). */
  stdio?: "inherit" | "ignore";
};

const is_code_family = (cmd: string): boolean =>
  /(^|\/)code(-insiders)?(\.exe)?$/i.test(cmd) ||
  /(^|\/)cursor(\.exe)?$/i.test(cmd);

/** Resolve which editor to invoke. Exposed for testing. */
export function pick_editor(env: NodeJS.ProcessEnv, override?: string): string {
  if (override) return override;
  return env.VISUAL || env.EDITOR || "vi";
}

/**
 * Build the argv passed to the editor. Public for testing.
 *
 *   vim/nvim/nano/emacs → `+<line> <file>`
 *   code/cursor          → `--goto <file>:<line>`
 */
export function editor_args(
  editor: string,
  file: string,
  line?: number
): string[] {
  if (line && is_code_family(editor)) return ["--goto", `${file}:${line}`];
  if (line) return [`+${line}`, file];
  return [file];
}

/** Open `file` (project-relative) at `line` in the user's editor. */
export async function open_in_editor(
  file: string,
  line: number | undefined,
  deps: EditorDeps
): Promise<{ ok: boolean; reason?: string }> {
  const editor = pick_editor(process.env, deps.editor);
  const abs_path = resolve(deps.root_dir, file);
  const args = editor_args(editor, abs_path, line);
  return await new Promise((resolveP) => {
    const child = spawn(editor, args, {
      /* c8 ignore next — "inherit" path runs only inside a real TTY. */
      stdio: deps.stdio ?? "inherit",
    });
    child.on("error", (err) => {
      resolveP({ ok: false, reason: err.message });
    });
    child.on("exit", (code) => {
      resolveP({
        ok: code === 0,
        reason: code === 0 ? undefined : `exit ${code}`,
      });
    });
  });
}
