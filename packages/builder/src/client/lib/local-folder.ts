/**
 * Read a local folder using the File System Access API (Chrome/Edge).
 * Walks the directory tree, collects .ts/.tsx files, applies the same
 * domain-file filtering used by the server-side GitHub import, and
 * follows imports from act() entry points.
 *
 * Persists directory handles in IndexedDB so recently opened folders
 * can be reopened without the picker (after a permission prompt).
 */
import type { FileTab } from "../types/index.js";

// ─── Feature detection ──────────────────────────────────────────────

/** Feature-detect browser support for showDirectoryPicker */
export function hasFileSystemAccess(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

// ─── Recent folders (IndexedDB) ─────────────────────────────────────

export type SavedFolder = { name: string; handle: FileSystemDirectoryHandle };

const DB_NAME = "act-builder";
const STORE_NAME = "local-folders";
const MAX_SAVED = 10;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "name" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

export async function loadSavedFolders(): Promise<SavedFolder[]> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () =>
        resolve((req.result as SavedFolder[]).slice(0, MAX_SAVED));
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

async function saveFolder(
  name: string,
  handle: FileSystemDirectoryHandle
): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put({ name, handle });

    // Enforce max saved limit
    const all = store.getAll();
    await new Promise<void>((resolve) => {
      all.onsuccess = () => {
        const items = all.result as SavedFolder[];
        if (items.length > MAX_SAVED) {
          for (const item of items.slice(MAX_SAVED)) {
            store.delete(item.name);
          }
        }
        resolve();
      };
      all.onerror = () => resolve();
    });
  } catch {
    // best-effort
  }
}

export async function removeSavedFolder(name: string): Promise<SavedFolder[]> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(name);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // best-effort
  }
  return loadSavedFolders();
}

// ─── Directory walking ──────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "test",
  ".next",
  ".turbo",
  "coverage",
]);
const SKIP_RE = /(?:__tests__|\/test\/|\.test\.|\.spec\.|\.bench\.|\.d\.ts$)/;

/** Walk a FileSystemDirectoryHandle, collecting .ts/.tsx file contents */
async function walkDirectory(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: Map<string, string>
) {
  for await (const [name, handle] of (dir as any).entries() as AsyncIterable<
    [string, FileSystemHandle]
  >) {
    if (handle.kind === "directory") {
      if (SKIP_DIRS.has(name)) continue;
      await walkDirectory(
        handle as FileSystemDirectoryHandle,
        prefix ? `${prefix}/${name}` : name,
        out
      );
    } else if (
      handle.kind === "file" &&
      /\.(ts|tsx|json|md|yaml|yml)$/.test(name) &&
      !name.endsWith(".d.ts")
    ) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (SKIP_RE.test(path)) continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      out.set(path, await file.text());
    }
  }
}

// ─── Read type definitions from local node_modules ──────────────────

const MAX_TYPE_BYTES = 20 * 1024 * 1024; // 20MB safety limit

/**
 * Selectively read .d.ts + package.json from node_modules for dependencies
 * listed in the project's package.json files. This gives the built-in ATA
 * pre-populated types so it doesn't need to fetch everything from npm.
 */
async function collectLocalTypes(
  rootDir: FileSystemDirectoryHandle,
  allFiles: Map<string, string>
): Promise<Map<string, string>> {
  const typeFiles = new Map<string, string>();

  // Gather dependency names from all package.json files
  const depNames = new Set<string>();
  for (const [path, content] of allFiles) {
    if (!path.endsWith("package.json")) continue;
    try {
      const pkg = JSON.parse(content);
      for (const field of ["dependencies", "devDependencies"]) {
        if (pkg[field] && typeof pkg[field] === "object") {
          for (const name of Object.keys(
            pkg[field] as Record<string, unknown>
          )) {
            depNames.add(name);
            // Also add @types/ counterpart for non-scoped packages
            if (!name.startsWith("@")) depNames.add(`@types/${name}`);
          }
        }
      }
    } catch {
      // skip
    }
  }
  // Always include @types/node
  depNames.add("@types/node");

  // Try to open node_modules
  let nmDir: FileSystemDirectoryHandle;
  try {
    nmDir = await rootDir.getDirectoryHandle("node_modules");
  } catch {
    return typeFiles; // no node_modules — ATA will handle it
  }

  let totalBytes = 0;

  async function walkTypePkg(dir: FileSystemDirectoryHandle, prefix: string) {
    for await (const [name, handle] of (dir as any).entries() as AsyncIterable<
      [string, FileSystemHandle]
    >) {
      if (totalBytes > MAX_TYPE_BYTES) return;
      const path = `${prefix}/${name}`;
      if (handle.kind === "directory") {
        await walkTypePkg(handle as FileSystemDirectoryHandle, path);
      } else if (
        handle.kind === "file" &&
        (name.endsWith(".d.ts") ||
          name.endsWith(".d.cts") ||
          name.endsWith(".d.mts") ||
          name === "package.json")
      ) {
        const file = await (handle as FileSystemFileHandle).getFile();
        if (totalBytes + file.size > MAX_TYPE_BYTES) return;
        const text = await file.text();
        totalBytes += text.length;
        typeFiles.set(`node_modules${path}`, text);
      }
    }
  }

  for (const dep of depNames) {
    if (totalBytes > MAX_TYPE_BYTES) break;
    try {
      if (dep.startsWith("@")) {
        // Scoped package: @scope/name → node_modules/@scope/name
        const [scope, name] = dep.split("/");
        const scopeDir = await nmDir.getDirectoryHandle(scope);
        const pkgDir = await scopeDir.getDirectoryHandle(name);
        await walkTypePkg(pkgDir, `/${dep}`);
      } else {
        const pkgDir = await nmDir.getDirectoryHandle(dep);
        await walkTypePkg(pkgDir, `/${dep}`);
      }
    } catch {
      // package not installed locally — ATA will fetch it
    }
  }

  return typeFiles;
}

// ─── Domain file filtering ──────────────────────────────────────────

/** Domain file heuristic — mirrors router.ts isDomainFile */
function isDomainFile(content: string, path: string): boolean {
  if (path.endsWith("/index.ts")) return true;
  if (/(?:^|=\s*)(?:state|slice|projection|act)\s*\(/m.test(content))
    return true;
  if (/\.withState\(|\.withSlice\(|\.withProjection\(/.test(content))
    return true;
  if (/\bz\.object\(|z\.enum\(|z\.string\(\)|z\.number\(\)/.test(content))
    return true;
  if (/\bInvariant\b/.test(content) && /valid\s*[:(]/.test(content))
    return true;
  if (/export\s+\*\s+from|export\s+\{/.test(content)) return true;
  return false;
}

/** Resolve a relative import from a source file path */
function resolveImport(imp: string, fromPath: string): string | undefined {
  if (!imp.startsWith(".")) return undefined;
  const dir = fromPath.includes("/")
    ? fromPath.slice(0, fromPath.lastIndexOf("/"))
    : "";
  const parts = (dir ? dir + "/" + imp : imp).split("/");
  const resolved: string[] = [];
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") resolved.pop();
    else resolved.push(p);
  }
  return resolved
    .join("/")
    .replace(/\.jsx$/, ".tsx")
    .replace(/\.js$/, ".ts");
}

// ─── Extract domain files from a directory handle ───────────────────

async function extractFiles(
  dirHandle: FileSystemDirectoryHandle
): Promise<FileTab[]> {
  const tsFiles = new Map<string, string>();
  await walkDirectory(dirHandle, "", tsFiles);

  if (tsFiles.size === 0) {
    throw new Error("No TypeScript files found in this folder");
  }

  // Read .d.ts from local node_modules so the editor has types immediately
  const localTypes = await collectLocalTypes(dirHandle, tsFiles);
  for (const [path, content] of localTypes) {
    tsFiles.set(path, content);
  }

  // Find act() entry points (skip node_modules and .d.ts)
  const entryPaths: string[] = [];
  for (const [path, content] of tsFiles) {
    if (path.startsWith("node_modules/") || path.endsWith(".d.ts")) continue;
    if (/\bact\s*\(\s*\)/.test(content) && /\.build\s*\(\s*\)/.test(content)) {
      entryPaths.push(path);
    }
  }

  // If no act() entry found, include all domain files as-is
  if (entryPaths.length === 0) {
    const files: FileTab[] = [];
    for (const [path, content] of tsFiles) {
      if (isDomainFile(content, path)) {
        files.push({ path, content });
      }
    }
    if (files.length === 0) {
      for (const [path, content] of tsFiles) files.push({ path, content });
    }
    return files;
  }

  // Follow imports from entry points — include all reachable files
  const collected = new Map<string, string>();
  const queue = [...entryPaths];

  while (queue.length > 0) {
    const filePath = queue.shift()!;
    if (collected.has(filePath)) continue;
    const content = tsFiles.get(filePath);
    if (!content) continue;
    collected.set(filePath, content);

    const importRe =
      /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+)?from\s+["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(content)) !== null) {
      if (/^import\s+type\s/.test(m[0])) continue;
      const imp = m[1];

      // Relative imports
      const resolved = resolveImport(imp, filePath);
      if (resolved) {
        if (!resolved.endsWith(".ts") && !resolved.endsWith(".tsx")) {
          if (tsFiles.has(resolved + ".ts")) queue.push(resolved + ".ts");
          else if (tsFiles.has(resolved + "/index.ts"))
            queue.push(resolved + "/index.ts");
        } else {
          queue.push(resolved);
        }
        continue;
      }

      // Workspace packages: @scope/name → packages/name/src/index.ts
      if (imp.startsWith("@") && !imp.startsWith("@rotorsoft/")) {
        const parts = imp.split("/");
        const pkgName = parts[1];
        if (pkgName) {
          const subPath = parts.slice(2).join("/");
          const candidates = subPath
            ? [
                `packages/${pkgName}/src/${subPath}.ts`,
                `packages/${pkgName}/src/${subPath}/index.ts`,
              ]
            : [`packages/${pkgName}/src/index.ts`];
          for (const c of candidates) {
            if (tsFiles.has(c)) {
              queue.push(c);
              break;
            }
          }
        }
      }
    }
  }

  // Include type files from node_modules alongside collected source files
  for (const [path, content] of localTypes) {
    if (!collected.has(path)) collected.set(path, content);
  }

  return [...collected.entries()].map(([path, content]) => ({ path, content }));
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Open a directory picker and return domain-relevant files.
 * Saves the handle to IndexedDB for later reuse.
 */
export async function openLocalFolder(): Promise<{
  name: string;
  files: FileTab[];
}> {
  const dirHandle = (await (window as any).showDirectoryPicker({
    mode: "read",
  })) as FileSystemDirectoryHandle;
  const files = await extractFiles(dirHandle);
  await saveFolder(dirHandle.name, dirHandle);
  return { name: dirHandle.name, files };
}

/**
 * Reopen a previously saved folder handle.
 * Re-requests permission (browser shows a one-click prompt).
 */
export async function reopenSavedFolder(
  saved: SavedFolder
): Promise<{ name: string; files: FileTab[] }> {
  const perm = await (saved.handle as any).requestPermission({ mode: "read" });
  if (perm !== "granted") {
    throw new Error(
      "Permission denied — select the folder again using Open Local"
    );
  }
  const files = await extractFiles(saved.handle);
  return { name: saved.name, files };
}
