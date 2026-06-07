import type { FileTab } from "../types/index.js";

/** Topological sort: files that are imported come before files that import them */
export function topo_sort(ts_files: FileTab[]): FileTab[] {
  if (ts_files.length <= 1) return ts_files;

  const strip = (p: string) => p.replace(/\.tsx?$/, "");

  // Build lookup
  const by_key = new Map<string, FileTab>();
  for (const f of ts_files) {
    by_key.set(strip(f.path), f);
  }

  // Build adjacency: file → set of files it depends on
  const deps = new Map<string, Set<string>>();
  for (const f of ts_files) {
    const key = strip(f.path);
    const file_deps = new Set<string>();
    deps.set(key, file_deps);

    const from_re = /from\s+["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = from_re.exec(f.content)) !== null) {
      const imp = m[1];
      const resolved = resolve(imp, key, by_key);
      if (resolved && by_key.has(resolved)) file_deps.add(resolved);
    }
  }

  // Kahn's algorithm (iterative topological sort)
  const in_degree = new Map<string, number>();
  for (const f of ts_files) in_degree.set(strip(f.path), 0);
  for (const [, file_deps] of deps) {
    for (const dep of file_deps) {
      in_degree.set(dep, in_degree.get(dep)! + 1);
    }
  }

  // Start with files that nobody depends on (leaves)
  // Actually for topo sort: start with files that have NO deps (sources)
  const queue: string[] = [];
  for (const [key, _deg] of in_degree) {
    if (deps.get(key)?.size === 0) queue.push(key);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    order.push(key);
    // For each file that depends on this one, reduce its pending count
    for (const [other, file_deps] of deps) {
      if (file_deps.has(key)) {
        file_deps.delete(key);
        if (file_deps.size === 0) queue.push(other);
      }
    }
  }

  // Add any remaining files (circular deps) at the end
  for (const f of ts_files) {
    const key = strip(f.path);
    if (!order.includes(key)) order.push(key);
  }

  return order.map((k) => by_key.get(k)!).filter(Boolean);
}

function resolve(
  imp: string,
  from_path: string,
  by_key?: Map<string, any>
): string | undefined {
  if (imp.startsWith(".")) {
    const dir = from_path.includes("/")
      ? from_path.slice(0, from_path.lastIndexOf("/"))
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
    const pkg_name = imp.split("/")[1];
    if (pkg_name) {
      // Try multiple patterns for monorepo workspace packages
      // Folder may be opened at project root (packages/pkg/src/index)
      // or at packages/ level (pkg/src/index)
      for (const candidate of [
        `packages/${pkg_name}/src/index`,
        `${pkg_name}/src/index`,
        `${pkg_name}/index`,
      ]) {
        if (by_key?.has(candidate)) return candidate;
      }
      return `packages/${pkg_name}/src/index`;
    }
  }
  return undefined;
}
