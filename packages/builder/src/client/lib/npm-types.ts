/**
 * Client-side npm type fetching — download .d.ts files from npm for
 * project dependencies and write them to the virtual filesystem.
 */
import type { InMemoryFileSystemProvider } from "@codingame/monaco-vscode-files-service-override";
import { WORKSPACE } from "./vscode-init.js";
import { writeFile } from "./workspace-fs.js";

/** Dispatch a custom event for NpmTerminal to pick up */
function emitTypeEvent(
  type: "start" | "done",
  pkg: string,
  extra?: { version?: string; elapsedMs?: number }
) {
  window.dispatchEvent(
    new CustomEvent("npm-type-fetch", { detail: { type, pkg, ...extra } })
  );
}

/**
 * Parse a gzipped npm tarball and extract .d.ts + package.json files.
 * Uses fflate for gunzip and a minimal tar header parser.
 */
async function extractTypesFromTarball(
  tarGz: ArrayBuffer
): Promise<Map<string, string>> {
  const { gunzipSync } = await import("fflate");
  const tar = gunzipSync(new Uint8Array(tarGz));
  const files = new Map<string, string>();
  const decoder = new TextDecoder();
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header[0] === 0) break;

    const fullName = decoder.decode(header.subarray(0, 100)).replace(/\0/g, "");

    const sizeOctal = decoder
      .decode(header.subarray(124, 136))
      .replace(/\0/g, "")
      .trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const typeFlag = header[156];

    offset += 512;

    if ((typeFlag === 48 || typeFlag === 0) && size > 0) {
      // Strip first path segment (varies: "package/", "node/", etc.)
      const path = fullName.replace(/^[^/]+\//, "");
      if (
        path.endsWith(".d.ts") ||
        path.endsWith(".d.ts.map") ||
        path === "package.json"
      ) {
        files.set(path, decoder.decode(tar.subarray(offset, offset + size)));
      }
    }

    offset += Math.ceil(size / 512) * 512;
  }

  return files;
}

/** Session-level cache: package name → extracted type files */
const typeCache = new Map<string, Map<string, string>>();

/**
 * Fetch .d.ts files from npm for project dependencies and write them
 * to the virtual filesystem. Called after project files are synced.
 *
 * Monorepo-aware: reads ALL package.json files and places types in
 * each sub-package's node_modules/ so tsserver resolves them correctly.
 * Cached per session — tarballs are only downloaded once.
 */
export async function fetchNpmTypes(
  fs: InMemoryFileSystemProvider,
  files: { path: string; content: string }[]
) {
  // Collect dependencies from ALL package.json files
  // Map: dep name → { version, dirs[] } where dirs are the package directories needing it
  const depMap = new Map<string, { ver: string; dirs: string[] }>();

  for (const f of files) {
    if (!f.path.endsWith("package.json") || f.path.startsWith("node_modules/"))
      continue;
    let pkg: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    try {
      pkg = JSON.parse(f.content);
    } catch {
      continue;
    }

    // Directory containing this package.json (empty string for root)
    const dir =
      f.path === "package.json" ? "" : f.path.replace(/\/package\.json$/, "");

    const deps: Record<string, string> = { ...pkg.dependencies };
    if (pkg.devDependencies) {
      for (const [k, v] of Object.entries(pkg.devDependencies)) {
        if (k.startsWith("@types/")) deps[k] = v;
      }
    }
    // Every package needs @types/node
    if (!deps["@types/node"]) deps["@types/node"] = "latest";

    for (const [name, ver] of Object.entries(deps)) {
      if (typeof ver === "string" && ver.startsWith("workspace:")) continue;
      const existing = depMap.get(name);
      if (existing) {
        if (!existing.dirs.includes(dir)) existing.dirs.push(dir);
      } else {
        depMap.set(name, { ver, dirs: [dir] });
      }
    }
  }

  // Also include packages referenced in tsconfig "types" fields (e.g. vitest/globals)
  for (const f of files) {
    if (
      !f.path.endsWith("tsconfig.json") &&
      !f.path.match(/tsconfig\.[^/]+\.json$/)
    )
      continue;
    try {
      // Strip JSON comments (tsconfig allows them)
      const stripped = f.content
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      const tsconfig = JSON.parse(stripped) as {
        compilerOptions?: { types?: string[] };
      };
      const types = tsconfig.compilerOptions?.types;
      if (!types) continue;

      const dir = f.path.includes("/")
        ? f.path.replace(/\/tsconfig[^/]*\.json$/, "")
        : "";

      for (const t of types) {
        // "vitest/globals" → package "vitest"
        const pkg = t.startsWith("@")
          ? t.split("/").slice(0, 2).join("/")
          : t.split("/")[0];
        if (!depMap.has(pkg)) {
          depMap.set(pkg, { ver: "latest", dirs: [dir] });
        } else {
          const existing = depMap.get(pkg)!;
          if (!existing.dirs.includes(dir)) existing.dirs.push(dir);
        }
      }
    } catch {
      // skip malformed tsconfig
    }
  }

  // Check which packages already have types (from server-side extraction)
  const hasTypes = new Set(
    files
      .filter((f) => f.path.includes("node_modules/"))
      .map((f) => {
        // Find the node_modules/ segment and extract the package name after it
        const nmIdx = f.path.indexOf("node_modules/");
        const after = f.path.slice(nmIdx + "node_modules/".length);
        const parts = after.split("/");
        return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
      })
  );

  // Fetch each unique package once (or use session cache), write to all dirs
  const fetches = [...depMap.entries()]
    .filter(([name]) => !hasTypes.has(name))
    .map(async ([name, { ver, dirs }]) => {
      try {
        let typeFiles = typeCache.get(name);

        if (!typeFiles) {
          // Not cached — fetch from npm
          const clean =
            typeof ver === "string" ? ver.replace(/^[~^>=<\s]+/, "") : "";
          // Only use as exact if it's ONLY a version number (no ranges like "2.10.0 - 3")
          const isExact = /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(clean);
          const tag = isExact ? clean : "latest";

          const metaRes = await fetch(`/npm-registry/${name}/${tag}`);
          if (!metaRes.ok) {
            console.warn(
              `[act-builder] types: ${name}/${tag} metadata ${metaRes.status}`
            );
            return;
          }
          const meta = await metaRes.json();
          const tarballUrl: string | undefined = meta.dist?.tarball;
          if (!tarballUrl) return;

          const proxyUrl = tarballUrl.replace(
            /https?:\/\/registry\.npmjs\.org\//,
            "/npm-registry/"
          );
          emitTypeEvent("start", name);
          const startMs = Date.now();
          const tarRes = await fetch(proxyUrl);
          if (!tarRes.ok) return;

          const tarGz = await tarRes.arrayBuffer();
          typeFiles = await extractTypesFromTarball(tarGz);
          if (typeFiles.size === 0) return;

          typeCache.set(name, typeFiles);
          const version = (meta.version as string) ?? undefined;
          emitTypeEvent("done", name, {
            version,
            elapsedMs: Date.now() - startMs,
          });
          console.log(
            `[act-builder] types: ${name}@${version} (${typeFiles.size} files → ${dirs.length} locations)`
          );
        } else {
          emitTypeEvent("done", name, { elapsedMs: 0 });
          console.log(
            `[act-builder] types: ${name} (cached → ${dirs.length} locations)`
          );
        }

        // Write to each package directory's node_modules
        for (const dir of dirs) {
          const nmBase = dir
            ? `${WORKSPACE}/${dir}/node_modules/${name}`
            : `${WORKSPACE}/node_modules/${name}`;
          for (const [filePath, content] of typeFiles) {
            await writeFile(fs, `${nmBase}/${filePath}`, content);
          }
        }
      } catch (err) {
        console.warn(`[act-builder] types: ${name} failed`, err);
      }
    });

  await Promise.all(fetches);
}
