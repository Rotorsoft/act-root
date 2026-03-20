import { exec } from "child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import { promisify } from "util";
import { extractTypesFromTarball } from "./tarball.js";

const execAsync = promisify(exec);

// ─── Types ───────────────────────────────────────────────────────────

export type CloneInput = {
  owner: string;
  repo: string;
  branch?: string;
  entryPath?: string;
};

type CollectedFile = { path: string; content: string };

// ─── Repo cache ──────────────────────────────────────────────────────

/** In-memory cache for cloned repo file trees (avoids re-cloning on every click) */
export const repoCache = new Map<
  string,
  { files: CollectedFile[]; sha: string }
>();

// ─── Shared clone + collect logic ────────────────────────────────────

/**
 * Clone a GitHub repo, scan source files, resolve the import graph,
 * and fetch npm type definitions for dependencies.
 *
 * Async to allow the event loop to flush SSE responses between steps.
 */
export async function cloneAndCollect(
  input: CloneInput,
  onProgress?: (text: string) => void
): Promise<{ files: CollectedFile[]; remoteSha: string }> {
  const { owner, repo, branch = "master" } = input;
  const progress = onProgress ?? (() => {});

  const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const cloneUrl = ghToken
    ? `https://${ghToken}@github.com/${owner}/${repo}.git`
    : `https://github.com/${owner}/${repo}.git`;

  // ── Check remote SHA ──────────────────────────────────────────────
  progress(`Checking ${owner}/${repo}...`);
  let remoteSha = "";
  try {
    const { stdout } = await execAsync(
      `git ls-remote ${cloneUrl} refs/heads/${branch}`,
      { timeout: 10000 }
    );
    remoteSha = stdout.split("\t")[0].trim();
  } catch {
    // ls-remote failed — skip cache, proceed with clone
  }

  // ── Check cache ───────────────────────────────────────────────────
  const cacheKey = `${owner}/${repo}/${branch}/${input.entryPath ?? ""}`;
  const cached = repoCache.get(cacheKey);
  if (cached && remoteSha && cached.sha === remoteSha) {
    progress(`Using cached version (${cached.files.length} files)`);
    return { files: cached.files, remoteSha };
  }

  // ── Clone ─────────────────────────────────────────────────────────
  progress(`Cloning ${owner}/${repo}#${branch}...`);
  const tmpDir = mkdtempSync(join(tmpdir(), "act-builder-"));
  try {
    try {
      await execAsync(
        `git clone --depth 1 --branch ${branch} ${cloneUrl} ${tmpDir}/repo`,
        { timeout: 30000 }
      );
    } catch (cloneErr) {
      const msg =
        cloneErr instanceof Error ? cloneErr.message : String(cloneErr);
      if (msg.includes("Repository not found") || msg.includes("404"))
        throw new Error(
          `Repository ${owner}/${repo} not found. Check the URL or set GITHUB_TOKEN for private repos.`,
          { cause: cloneErr }
        );
      if (msg.includes("not find remote branch"))
        throw new Error(
          `Branch "${branch}" not found in ${owner}/${repo}. Try "main" or "master".`,
          { cause: cloneErr }
        );
      if (msg.includes("timed out"))
        throw new Error(`Clone timed out for ${owner}/${repo}. Try again.`, {
          cause: cloneErr,
        });
      throw new Error(`Clone failed: ${msg.slice(0, 200)}`, {
        cause: cloneErr,
      });
    }
    const repoDir = join(tmpDir, "repo");

    // ── Scan files (sync — fast, no child processes) ────────────────
    progress("Scanning source files...");
    const COLLECT_RE = /\.(ts|tsx|json|md|yaml|yml)$/;
    const tsFiles = new Map<string, string>();
    const allRepoFiles = new Map<string, string>();
    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        if (
          entry === "node_modules" ||
          entry === ".git" ||
          entry === "dist" ||
          entry === "coverage"
        )
          continue;
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (COLLECT_RE.test(entry) && !entry.endsWith(".d.ts")) {
          const rel = relative(repoDir, full);
          const content = readFileSync(full, "utf-8");
          allRepoFiles.set(rel, content);
          if (/\.(ts|tsx)$/.test(entry)) {
            tsFiles.set(rel, content);
          }
        }
      }
    }
    walk(repoDir);
    progress(`Found ${allRepoFiles.size} files (${tsFiles.size} TypeScript)`);

    // ── Find entry points ───────────────────────────────────────────
    progress("Finding act() entry points...");
    const entryPaths: string[] = [];
    const skipPaths =
      /(?:__tests__|\/test\/|\.test\.|\.spec\.|\.bench\.|node_modules|dist\/|\.d\.ts$|\/inspector\/|\/builder\/|libs\/act[^/]*\/src\/|\/main\.ts$)/;
    if (input.entryPath) {
      entryPaths.push(input.entryPath);
    } else {
      for (const [path, content] of tsFiles) {
        if (skipPaths.test(path)) continue;
        if (
          /\bact\s*\(\s*\)/.test(content) &&
          /\.build\s*\(\s*\)/.test(content)
        ) {
          entryPaths.push(path);
        }
      }
    }
    if (entryPaths.length === 0) {
      throw new Error("No act() builder entry found in repository");
    }
    progress(
      `Found ${entryPaths.length} entry point${entryPaths.length > 1 ? "s" : ""}`
    );
    for (const ep of entryPaths) {
      progress(`  ✓ ${ep}`);
    }

    // ── Follow imports ──────────────────────────────────────────────
    progress("Resolving import graph...");
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
        if (imp.startsWith(".")) {
          const dir = filePath.includes("/")
            ? filePath.slice(0, filePath.lastIndexOf("/"))
            : "";
          const parts = (dir ? dir + "/" + imp : imp).split("/");
          const resolved: string[] = [];
          for (const p of parts) {
            if (p === "." || p === "") continue;
            if (p === "..") resolved.pop();
            else resolved.push(p);
          }
          const rp = resolved
            .join("/")
            .replace(/\.jsx$/, ".tsx")
            .replace(/\.js$/, ".ts");
          if (!rp.endsWith(".ts") && !rp.endsWith(".tsx")) {
            if (tsFiles.has(rp + ".ts")) queue.push(rp + ".ts");
            else if (tsFiles.has(rp + "/index.ts"))
              queue.push(rp + "/index.ts");
          } else {
            queue.push(rp);
          }
        } else if (imp.startsWith("@")) {
          const parts = imp.split("/");
          const pkgName = parts[1];
          if (pkgName) {
            const subPath = parts.slice(2).join("/");
            const dirs = ["packages", "libs"];
            const candidates = dirs.flatMap((d) =>
              subPath
                ? [
                    `${d}/${pkgName}/src/${subPath}.ts`,
                    `${d}/${pkgName}/src/${subPath}/index.ts`,
                  ]
                : [`${d}/${pkgName}/src/index.ts`]
            );
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

    // Merge config files
    const CONFIG_RE =
      /(?:package\.json|tsconfig[^/]*\.json|pnpm-workspace\.yaml|\.npmrc)$/;
    for (const [path, content] of allRepoFiles) {
      if (!collected.has(path) && CONFIG_RE.test(path)) {
        collected.set(path, content);
      }
    }
    progress(`Collected ${collected.size} source + config files`);

    // ── Fetch .d.ts files from npm for direct dependencies ────────
    progress("Fetching type definitions...");
    const depMap = new Map<string, { ver: string; dirs: string[] }>();
    for (const [path, content] of allRepoFiles) {
      if (!path.endsWith("package.json")) continue;
      try {
        const pkg = JSON.parse(content);
        const dir =
          path === "package.json" ? "" : path.replace(/\/package\.json$/, "");
        const deps: Record<string, string> = { ...pkg.dependencies };
        if (pkg.devDependencies) {
          for (const [k, v] of Object.entries(
            pkg.devDependencies as Record<string, string>
          )) {
            if (k.startsWith("@types/")) deps[k] = v;
          }
        }
        if (!deps["@types/node"]) deps["@types/node"] = "latest";

        for (const [name, ver] of Object.entries(deps)) {
          if (typeof ver === "string" && ver.startsWith("workspace:")) continue;
          if (
            tsFiles.has(`libs/${name.replace(/^@[^/]+\//, "")}/src/index.ts`) ||
            tsFiles.has(
              `packages/${name.replace(/^@[^/]+\//, "")}/src/index.ts`
            )
          )
            continue;
          const existing = depMap.get(name);
          if (existing) {
            if (!existing.dirs.includes(dir)) existing.dirs.push(dir);
          } else {
            depMap.set(name, { ver, dirs: [dir] });
          }
        }
      } catch {
        // skip malformed
      }
    }

    let typesCount = 0;
    for (const [name] of depMap) {
      try {
        const { stdout: tarballUrl } = await execAsync(
          `npm view ${name} dist.tarball 2>/dev/null`,
          { timeout: 10000 }
        );
        const url = tarballUrl.trim();
        if (!url) continue;

        const { stdout: tarGzBuf } = await execAsync(`curl -sL "${url}"`, {
          maxBuffer: 50 * 1024 * 1024,
          timeout: 30000,
          encoding: "buffer",
        });
        const typeFiles = extractTypesFromTarball(
          tarGzBuf as unknown as Buffer
        );
        if (typeFiles.size === 0) continue;
        const dirs = depMap.get(name)!.dirs;
        for (const dir of dirs) {
          const nmBase = dir
            ? `${dir}/node_modules/${name}`
            : `node_modules/${name}`;
          for (const [filePath, content] of typeFiles) {
            collected.set(`${nmBase}/${filePath}`, content);
          }
        }
        typesCount++;
        progress(`Types: ${name} (${typeFiles.size} files)`);
      } catch {
        // skip — client-side fetchNpmTypes will handle it
      }
    }
    progress(`Fetched types for ${typesCount} packages`);

    // ── Build result ──────────────────────────────────────────────
    const files = [...collected.entries()].map(([path, content]) => ({
      path,
      content,
    }));

    if (remoteSha) {
      repoCache.set(cacheKey, { files, sha: remoteSha });
    }

    return { files, remoteSha };
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
}

// ─── Streaming git clone (SSE) ───────────────────────────────────────

export function streamFetchFromGit(
  input: CloneInput,
  res: import("http").ServerResponse
) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (type: string, data: Record<string, unknown> = {}) =>
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  void cloneAndCollect(input, (text) => {
    send("status", { text });
  })
    .then(({ files }) => {
      send("done", { files });
    })
    .catch((err: unknown) => {
      send("error", {
        message: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      res.end();
    });
}
