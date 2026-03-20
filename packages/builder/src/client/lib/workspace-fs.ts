/**
 * Virtual filesystem helpers — write files to the in-memory filesystem
 * that backs the VS Code workbench.
 */
import {
  InMemoryFileSystemProvider,
  type IFileWriteOptions,
} from "@codingame/monaco-vscode-files-service-override";
import * as vscode from "vscode";
import { WORKSPACE } from "./vscode-init.js";

export type { InMemoryFileSystemProvider };

const textEncoder = new TextEncoder();
const writeOpts: IFileWriteOptions = {
  atomic: false,
  unlock: false,
  create: true,
  overwrite: true,
};

let createdDirs = new Set<string>();

/** Ensure parent directories exist, then write file */
export async function writeFile(
  fs: InMemoryFileSystemProvider,
  path: string,
  content: string
) {
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    const dir = "/" + parts.slice(0, i).join("/");
    if (createdDirs.has(dir)) continue;
    try {
      await fs.mkdir(vscode.Uri.file(dir));
    } catch {
      // already exists
    }
    createdDirs.add(dir);
  }
  await fs.writeFile(
    vscode.Uri.file(path),
    textEncoder.encode(content),
    writeOpts
  );
}

/** Remove all files from the workspace to prepare for a new project */
export async function clearWorkspace(fs: InMemoryFileSystemProvider) {
  const wsUri = vscode.Uri.file(WORKSPACE);
  try {
    const entries = await fs.readdir(wsUri);
    for (const [name] of entries) {
      try {
        await fs.delete(vscode.Uri.file(`${WORKSPACE}/${name}`), {
          recursive: true,
          useTrash: false,
          atomic: false,
        });
      } catch {
        // best effort
      }
    }
  } catch {
    // workspace dir might not exist yet
  }
  createdDirs = new Set<string>();
  skippedDevDeps.length = 0;
}

/** Strip pnpm workspace protocol from package.json dependencies */
/** DevDependencies skipped from ATA — exposed for the NpmTerminal UI */
export const skippedDevDeps: string[] = [];

/** Sanitize files for the virtual filesystem only (doesn't affect exports) */
function sanitizeContent(path: string, content: string): string {
  // Sanitize tsconfig files: force types to ["node"] and skipLibCheck.
  // Trailing commas (valid JSONC) are stripped before JSON.parse.
  if (
    path.endsWith(".json") &&
    !path.startsWith("node_modules/") &&
    /tsconfig[^/]*\.json$/.test(path)
  ) {
    try {
      const cleaned = content
        .replace(/\/\/[^\n]*/g, "")
        .replace(/,\s*([\]}])/g, "$1");
      const tsconfig = JSON.parse(cleaned);
      if (!tsconfig.compilerOptions) tsconfig.compilerOptions = {};
      const co = tsconfig.compilerOptions;
      co.types = ["node"];
      co.skipLibCheck = true;
      return JSON.stringify(tsconfig, null, 2);
    } catch {
      return content;
    }
  }
  if (path.endsWith("package.json") && !path.startsWith("node_modules/")) {
    try {
      const pkg = JSON.parse(content);
      // Remove workspace: dependencies entirely — nassun would try to resolve
      // them from npm and fail for private packages, breaking project init.
      // Workspace packages are wired via node_modules shims in writeWorkspaceFile.
      for (const field of ["dependencies", "devDependencies"]) {
        const deps = pkg[field];
        if (deps) {
          for (const [k, v] of Object.entries(deps as Record<string, string>)) {
            if (typeof v === "string" && v.startsWith("workspace:")) {
              delete (deps as Record<string, string>)[k];
            }
          }
        }
      }
      // Strip devDependencies except @types/* packages (which are type-only
      // and essential for IntelliSense). This prevents ATA from resolving
      // vitest → vite → rollup → 20 platform packages (saves 400+ npm fetches).
      // The original files array is preserved for zip export.
      if (pkg.devDependencies) {
        const kept: Record<string, string> = {};
        for (const [name, ver] of Object.entries(
          pkg.devDependencies as Record<string, string>
        )) {
          if (name.startsWith("@types/")) {
            kept[name] = ver;
          } else {
            if (!skippedDevDeps.includes(name)) skippedDevDeps.push(name);
          }
        }
        if (Object.keys(kept).length > 0) {
          pkg.devDependencies = kept;
        } else {
          delete pkg.devDependencies;
        }
      }
      return JSON.stringify(pkg, null, 2);
    } catch {
      return content.replace(/"workspace:[*^~]"/g, '"*"');
    }
  }
  return content;
}

/** Write a user file to the workspace. Auto-creates node_modules entries for workspace packages. */
export async function writeWorkspaceFile(
  fs: InMemoryFileSystemProvider,
  path: string,
  content: string
) {
  const sanitized = sanitizeContent(path, content);
  await writeFile(fs, `${WORKSPACE}/${path}`, sanitized);

  // Auto-create node_modules entry for workspace sub-packages
  // (skip if path is already under node_modules — server provided real types)
  if (
    !path.startsWith("node_modules/") &&
    path !== "package.json" &&
    path.endsWith("/package.json")
  ) {
    try {
      const pkg = JSON.parse(sanitized) as { name?: string };
      if (pkg.name) {
        const pkgDir = path.replace(/\/package\.json$/, "");
        const nmSegments = `node_modules/${pkg.name}`.split("/").length;
        const rel = "../".repeat(nmSegments) + pkgDir;
        await writeFile(
          fs,
          `${WORKSPACE}/node_modules/${pkg.name}/package.json`,
          JSON.stringify({
            name: pkg.name,
            version: "0.0.0",
            types: `${rel}/src/index.ts`,
          })
        );
      }
    } catch {
      // skip malformed package.json
    }
  }
}

/**
 * Update the workspace tsconfig.json with paths mappings for all workspace
 * sub-packages. This avoids tsserver project boundary errors when one package
 * imports another through node_modules shims.
 */
export async function updateWorkspacePaths(
  fs: InMemoryFileSystemProvider,
  files: { path: string; content: string }[]
) {
  const paths: Record<string, string[]> = {};
  for (const f of files) {
    if (
      f.path.startsWith("node_modules/") ||
      f.path === "package.json" ||
      !f.path.endsWith("/package.json")
    )
      continue;
    try {
      const pkg = JSON.parse(f.content) as { name?: string };
      if (pkg.name) {
        const pkgDir = f.path.replace(/\/package\.json$/, "");
        paths[pkg.name] = [`./${pkgDir}/src/index.ts`];
        paths[`${pkg.name}/*`] = [`./${pkgDir}/src/*`];
      }
    } catch {
      // skip
    }
  }
  if (Object.keys(paths).length === 0) return;

  await writeFile(
    fs,
    `${WORKSPACE}/tsconfig.json`,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "node",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          jsx: "react-jsx",
          allowImportingTsExtensions: true,
          noEmit: true,
          baseUrl: ".",
          paths,
        },
        include: ["src/**/*", "packages/*/src/**/*", "libs/*/src/**/*"],
      },
      null,
      2
    )
  );
}
