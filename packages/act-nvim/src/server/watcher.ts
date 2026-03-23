import { watch, type FSWatcher } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export type FileTab = { path: string; content: string };

const EXCLUDE_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "coverage",
  ".turbo",
]);

const isTs = (name: string) => name.endsWith(".ts") && !name.endsWith(".d.ts");

/** Recursively scan a directory for .ts files, returning relative paths */
export async function scanDir(root: string): Promise<FileTab[]> {
  const files: FileTab[] = [];

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!EXCLUDE_DIRS.has(entry.name)) await walk(join(dir, entry.name));
      } else if (entry.isFile() && isTs(entry.name)) {
        const abs = join(dir, entry.name);
        const content = await readFile(abs, "utf-8");
        files.push({ path: relative(root, abs), content });
      }
    }
  }

  await walk(root);
  return files;
}

export type WatchEvent =
  | { type: "fileChanged"; path: string; content: string }
  | { type: "fileDeleted"; path: string };

/** Watch a directory for .ts file changes, debounced */
export function watchDir(
  root: string,
  onChange: (event: WatchEvent) => void
): FSWatcher {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const watcher = watch(root, { recursive: true }, (_eventType, filename) => {
    if (!filename || !isTs(filename)) return;
    if (filename.split("/").some((seg) => EXCLUDE_DIRS.has(seg))) return;

    // debounce per file
    const existing = timers.get(filename);
    if (existing) clearTimeout(existing);

    timers.set(
      filename,
      setTimeout(async () => {
        timers.delete(filename);
        const abs = join(root, filename);
        try {
          await stat(abs);
          const content = await readFile(abs, "utf-8");
          onChange({ type: "fileChanged", path: filename, content });
        } catch {
          onChange({ type: "fileDeleted", path: filename });
        }
      }, 100)
    );
  });

  return watcher;
}
