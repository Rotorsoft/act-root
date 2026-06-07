import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Options for {@link runStabilityTck}.
 *
 * @property name - Display name for the snapshot suite (e.g., the package
 *   name). Used as the `describe` block label so failing snapshots are
 *   attributable at a glance.
 * @property entryPoints - Map of subpath → entry source file. The TCK
 *   reads each entry, follows its relative re-exports recursively, and
 *   snapshots the resulting surface text. Empty-string subpaths label
 *   the root entry; everything else is rendered with its key (e.g.
 *   `"/receiver"`).
 */
export type StabilityTckOptions = {
  readonly name: string;
  readonly entryPoints: Readonly<Record<string, string>>;
};

/**
 * Snapshot-based public-API stability check. Walks each entry's source
 * file plus everything it re-exports through relative imports, and
 * compares the concatenated text against a committed Vitest snapshot.
 *
 * Catches accidental rename / removal / signature drift on the public
 * surface before a build merges. Any change that affects re-exports
 * shows up as a snapshot diff in the PR; reviewers either accept the
 * change (update the snapshot deliberately) or push back.
 *
 * The TCK reads source (`.ts`) rather than built declarations so it
 * doesn't need a prior `pnpm build`. It follows `from "./relative.js"`
 * re-exports transitively; non-relative paths (other packages, `node:`)
 * stop the walk — drift in another package's surface is that package's
 * stability TCK to catch.
 *
 * @example
 * ```ts
 * import path from "node:path";
 * import { runStabilityTck } from "@rotorsoft/act-tck";
 *
 * runStabilityTck({
 *   name: "@rotorsoft/act-http",
 *   entryPoints: {
 *     "/api": path.resolve("src/api/index.ts"),
 *     "/webhook": path.resolve("src/webhook/index.ts"),
 *     "/sse": path.resolve("src/sse/index.ts"),
 *     "/receiver": path.resolve("src/receiver/index.ts"),
 *   },
 * });
 * ```
 *
 * @param options - See {@link StabilityTckOptions}.
 */
export function runStabilityTck(options: StabilityTckOptions): void {
  describe(`${options.name} — public API stability`, () => {
    for (const [subpath, entry] of Object.entries(options.entryPoints)) {
      const label = subpath || "(root)";
      it(`stable public surface for ${label}`, async () => {
        const surface = await load_surface(entry);
        expect(surface).toMatchSnapshot();
      });
    }
  });
}

/**
 * Load and concatenate the public surface of an entry source file.
 * Recursively walks relative re-exports, deduplicating visited files
 * and sorting visited paths so cosmetic file-order changes don't shift
 * the snapshot.
 */
async function load_surface(entry: string): Promise<string> {
  const visited = new Map<string, string>();

  async function walk(file: string): Promise<void> {
    const abs = path.resolve(file);
    if (visited.has(abs)) return;

    const content = await fs.readFile(abs, "utf8");
    visited.set(abs, content);

    // Follow `from "./relative.js"` re-exports / imports.
    const re_export = /\bfrom\s+["'](\.[^"']+)["']/g;
    for (const m of content.matchAll(re_export)) {
      const rel = m[1].replace(/\.js$/, ".ts");
      const target = path.resolve(path.dirname(abs), rel);
      await walk(target);
    }
  }

  await walk(entry);

  // Sort by basename for stable ordering across machines.
  const sorted = [...visited.entries()].sort(([a], [b]) =>
    path.basename(a).localeCompare(path.basename(b))
  );
  return sorted
    .map(([abs, content]) => {
      const rel = path.basename(abs);
      return `// === ${rel} ===\n${content}`;
    })
    .join("\n");
}
