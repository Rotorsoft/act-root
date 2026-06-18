/**
 * Filesystem walker for the act-contracts CLI.
 * Recursively reads TypeScript source files from a project root and
 * returns a FileTab[] in the same shape `extract_model` already consumes.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import type { FileTab } from "../client/types/file-tab.js";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "build",
  ".git",
  ".turbo",
  ".next",
  ".vercel",
  // tests
  "__tests__",
  "test",
  "tests",
  "e2e",
  // benchmarks
  "bench",
  "benches",
  "benchmark",
  "benchmarks",
  "perf",
  // build-time scripts and generated artifacts
  "scripts",
]);

const SKIP_FILE_RE = /\.(?:d\.ts|tsx|test\.ts|spec\.ts|bench\.ts|perf\.ts)$/;

export type LoadOptions = {
  /** Maximum number of files to read. Default 5000 — protects against runaway scans. */
  max_files?: number;
};

export type LoadResult = {
  files: FileTab[];
  truncated: boolean;
};

/**
 * Walk `root_dir` and return every `.ts` file that survives the skip rules.
 * Returned `FileTab.path` values are project-relative (POSIX separators).
 */
export async function load_project(
  root_dir: string,
  opts: LoadOptions = {}
): Promise<LoadResult> {
  const max = opts.max_files ?? 5000;
  const files: FileTab[] = [];
  let truncated = false;

  const visit = async (abs_dir: string, rel_dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = (await readdir(abs_dir, { withFileTypes: true })) as Dirent[];
      /* c8 ignore start — defensive against perms/removed-dir races. */
    } catch {
      return;
    }
    /* c8 ignore stop */
    for (const entry of entries) {
      if (files.length >= max) {
        truncated = true;
        return;
      }
      const name = entry.name;
      if (name.startsWith(".") && name !== ".") continue;
      const abs_path = posix.join(abs_dir.replace(/\\/g, "/"), name);
      const rel_path = rel_dir ? posix.join(rel_dir, name) : name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        await visit(abs_path, rel_path);
        continue;
      }
      // Defensive against symlinks / FIFOs / devices.
      /* c8 ignore start */
      if (!entry.isFile()) continue;
      /* c8 ignore stop */
      if (!name.endsWith(".ts")) continue;
      if (SKIP_FILE_RE.test(name)) continue;
      try {
        const content = await readFile(abs_path, "utf8");
        files.push({ path: rel_path, content });
      } catch {
        // unreadable file — skip
      }
    }
  };

  const root_stat = await stat(root_dir).catch(() => null);
  if (!root_stat?.isDirectory()) {
    return { files, truncated };
  }
  await visit(root_dir.replace(/\\/g, "/"), "");
  return { files, truncated };
}
