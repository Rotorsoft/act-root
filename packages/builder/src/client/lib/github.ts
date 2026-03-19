/** Parse GitHub URL → owner/repo/branch/path (path optional) */
export function parseGitUrl(url: string): {
  owner: string;
  repo: string;
  branch: string;
  entryPath?: string;
} | null {
  // Full path: github.com/owner/repo/blob/branch/path/to/file.ts
  const full = url.match(
    /github\.com\/([^/]+)\/([^/]+)\/(?:blob|tree)\/([^/]+)\/(.+)/
  );
  if (full)
    return {
      owner: full[1],
      repo: full[2],
      branch: full[3],
      entryPath: full[4],
    };
  // Repo only: github.com/owner/repo (auto-detect entry + default branch)
  const repo = url.match(/github\.com\/([^/]+)\/([^/\s]+)/);
  if (repo)
    return {
      owner: repo[1],
      repo: repo[2].replace(/\.git$/, ""),
      branch: "master",
    };
  return null;
}

export type SavedImport = { url: string; label: string };

const STORAGE_KEY = "act-builder:git-imports";

export function loadSavedImports(): SavedImport[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function repoLabel(url: string): string {
  const parts = url
    .replace(/https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .split("/");
  return parts.length > 4
    ? parts
        .slice(1)
        .filter((p) => p !== "blob" && p !== "tree")
        .join("/")
        .replace(/\.ts$/, "")
    : parts.slice(0, 2).join("/");
}

export function saveImport(url: string) {
  const saved = loadSavedImports();
  const label = repoLabel(url);
  if (saved.some((s) => s.url === url)) return;
  const updated = [{ url, label }, ...saved].slice(0, 10);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export function removeSavedImport(url: string): SavedImport[] {
  const updated = loadSavedImports().filter((x) => x.url !== url);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  return updated;
}
