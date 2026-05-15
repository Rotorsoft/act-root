/**
 * Filesystem walker for the act-contracts CLI.
 * Recursively reads TypeScript source files from a project root and
 * returns a FileTab[] in the same shape `extractModel` already consumes.
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
  maxFiles?: number;
};

export type LoadResult = {
  files: FileTab[];
  truncated: boolean;
};

/**
 * Walk `rootDir` and return every `.ts` file that survives the skip rules.
 * Returned `FileTab.path` values are project-relative (POSIX separators).
 */
export async function loadProject(
  rootDir: string,
  opts: LoadOptions = {}
): Promise<LoadResult> {
  const max = opts.maxFiles ?? 5000;
  const files: FileTab[] = [];
  let truncated = false;

  const visit = async (absDir: string, relDir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = (await readdir(absDir, { withFileTypes: true })) as Dirent[];
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
      const absPath = posix.join(absDir.replace(/\\/g, "/"), name);
      const relPath = relDir ? posix.join(relDir, name) : name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        await visit(absPath, relPath);
        continue;
      }
      // Defensive against symlinks / FIFOs / devices.
      /* c8 ignore start */
      if (!entry.isFile()) continue;
      /* c8 ignore stop */
      if (!name.endsWith(".ts")) continue;
      if (SKIP_FILE_RE.test(name)) continue;
      try {
        const content = await readFile(absPath, "utf8");
        files.push({ path: relPath, content });
      } catch {
        // unreadable file — skip
      }
    }
  };

  const rootStat = await stat(rootDir).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) {
    return { files, truncated };
  }
  await visit(rootDir.replace(/\\/g, "/"), "");
  return { files, truncated };
}
