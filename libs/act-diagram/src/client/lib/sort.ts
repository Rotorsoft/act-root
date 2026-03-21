import type { FileTab } from "../types/index.js";

/** Topological sort: files that are imported come before files that import them */
export function topoSort(tsFiles: FileTab[]): FileTab[] {
  if (tsFiles.length <= 1) return tsFiles;

  const strip = (p: string) => p.replace(/\.tsx?$/, "");

  // Build lookup
  const byKey = new Map<string, FileTab>();
  for (const f of tsFiles) {
    byKey.set(strip(f.path), f);
  }

  // Build adjacency: file → set of files it depends on
  const deps = new Map<string, Set<string>>();
  for (const f of tsFiles) {
    const key = strip(f.path);
    const fileDeps = new Set<string>();
    deps.set(key, fileDeps);

    const fromRe = /from\s+["']([^"']+)["']/g;
    let m;
    while ((m = fromRe.exec(f.content)) !== null) {
      const imp = m[1];
      const resolved = resolve(imp, key, byKey);
      if (resolved && byKey.has(resolved)) fileDeps.add(resolved);
    }
  }

  // Kahn's algorithm (iterative topological sort)
  const inDegree = new Map<string, number>();
  for (const f of tsFiles) inDegree.set(strip(f.path), 0);
  for (const [, fileDeps] of deps) {
    for (const dep of fileDeps) {
      /* v8 ignore next -- dep always seeded in inDegree map */
      inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1);
    }
  }

  // Start with files that nobody depends on (leaves)
  // Actually for topo sort: start with files that have NO deps (sources)
  const queue: string[] = [];
  for (const [key, _deg] of inDegree) {
    if (deps.get(key)?.size === 0) queue.push(key);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    order.push(key);
    // For each file that depends on this one, reduce its pending count
    for (const [other, fileDeps] of deps) {
      if (fileDeps.has(key)) {
        fileDeps.delete(key);
        if (fileDeps.size === 0) queue.push(other);
      }
    }
  }

  // Add any remaining files (circular deps) at the end
  for (const f of tsFiles) {
    const key = strip(f.path);
    if (!order.includes(key)) order.push(key);
  }

  return order.map((k) => byKey.get(k)!).filter(Boolean);
}

function resolve(
  imp: string,
  fromPath: string,
  byKey?: Map<string, any>
): string | undefined {
  if (imp.startsWith(".")) {
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
    return resolved.join("/").replace(/\.js$/, "").replace(/\.ts$/, "");
  }
  if (imp.startsWith("@") && !imp.startsWith("@rotorsoft/")) {
    const pkgName = imp.split("/")[1];
    if (pkgName) {
      // Try multiple patterns for monorepo workspace packages
      // Folder may be opened at project root (packages/pkg/src/index)
      // or at packages/ level (pkg/src/index)
      for (const candidate of [
        `packages/${pkgName}/src/index`,
        `${pkgName}/src/index`,
        `${pkgName}/index`,
      ]) {
        if (byKey?.has(candidate)) return candidate;
      }
      return `packages/${pkgName}/src/index`;
    }
  }
  return undefined;
}
