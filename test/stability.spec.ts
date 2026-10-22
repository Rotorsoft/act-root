import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStabilityTck } from "@rotorsoft/act-tck";

/**
 * Workspace-level stability gate. Auto-discovers every `@rotorsoft/*`
 * package under `libs/` and runs `runStabilityTck` against the published
 * declarations (`types`) of each entry point in the package's `exports`
 * field, so the snapshot records the surface and not the implementation.
 * New packages and new subpath exports get picked up automatically — no
 * per-package wiring.
 *
 * It reads `dist/`, so it runs after `pnpm build` (`pnpm check:stability`)
 * and stays out of the default `pnpm test` run, where a stale build would
 * give a wrong answer.
 *
 * Snapshots live next to this file (`__snapshots__/stability.spec.ts.snap`).
 * One snapshot key per `package + subpath` pair; a public-surface change
 * to package X surfaces as a one-block diff in that single file. It lives
 * at the repo root, not in a published package, so a snapshot change
 * never releases one.
 */

const libs_dir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "libs"
);

type ExportMap = Record<string, string | { types?: string }>;
type Pkg = { name: string; entry_points: Record<string, string> };

// act-diagram is mostly a UI tool (React components, `.tsx`). The
// stability check is scoped to library surfaces only; React-component
// public types are handled by their own component-prop conformance and
// don't belong in a snake-case-or-camelCase rename gate.
const UI_PACKAGES = new Set(["@rotorsoft/act-diagram"]);

function discover_packages(): Pkg[] {
  const packages: Pkg[] = [];
  for (const dir of readdirSync(libs_dir).sort()) {
    const pkg_json_path = path.join(libs_dir, dir, "package.json");
    let manifest: { name?: string; exports?: ExportMap };
    try {
      manifest = JSON.parse(readFileSync(pkg_json_path, "utf8"));
    } catch {
      continue;
    }
    if (!manifest.name?.startsWith("@rotorsoft/")) continue;
    if (UI_PACKAGES.has(manifest.name)) continue;
    const exports = manifest.exports ?? {};
    const entry_points: Record<string, string> = {};
    for (const [subpath, mapping] of Object.entries(exports)) {
      const types = typeof mapping === "string" ? undefined : mapping?.types;
      if (!types?.endsWith(".d.ts")) continue;
      const abs_types = path.join(libs_dir, dir, types);
      if (!existsSync(abs_types))
        throw new Error(
          `${manifest.name}: ${types} is missing. Run \`pnpm build\` before \`pnpm check:stability\`.`
        );
      const key = subpath === "." ? "" : subpath;
      entry_points[key] = abs_types;
    }
    if (Object.keys(entry_points).length > 0) {
      packages.push({ name: manifest.name, entry_points });
    }
  }
  return packages;
}

for (const pkg of discover_packages()) {
  runStabilityTck({ name: pkg.name, entryPoints: pkg.entry_points });
}
