import Anthropic from "@anthropic-ai/sdk";
import { initTRPC } from "@trpc/server";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

const t = initTRPC.create();

// ─── AI code generation ────────────────────────────────────────────

/**
 * Load skill files at module init — tried in order:
 * 1. BUILDER_SKILLS_DIR env var (explicit path)
 * 2. Walk up from this file to find .claude/skills/scaffold-act-app/
 * 3. Empty string fallback (builder works without skills, just less context)
 */
function findSkillsDir(): string | null {
  const envDir = process.env.BUILDER_SKILLS_DIR;
  if (envDir && existsSync(envDir)) return envDir;

  // Walk up from this file's directory to find the monorepo root
  const thisDir =
    typeof __dirname !== "undefined"
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
  let dir = thisDir;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, ".claude/skills/scaffold-act-app");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function loadSkillFile(skillsDir: string | null, name: string): string {
  if (!skillsDir) return "";
  try {
    return readFileSync(join(skillsDir, name), "utf-8");
  } catch {
    return "";
  }
}

const SKILLS_DIR = findSkillsDir();
const SKILL_CONTENT = loadSkillFile(SKILLS_DIR, "SKILL.md");
const API_CONTENT = loadSkillFile(SKILLS_DIR, "act-api.md");

const SYSTEM_PROMPT = `You are an expert Act framework developer generating TypeScript code using @rotorsoft/act.

${SKILL_CONTENT ? `${SKILL_CONTENT}\n\n` : ""}${API_CONTENT ? `${API_CONTENT}\n\n` : ""}## Builder Output Rules
- Generate a SINGLE file with all states, slices, projections, and orchestrator
- Import from "@rotorsoft/act" and "zod" only
- Add JSDoc comments explaining the domain model and key design decisions
- Name reaction handlers with \`async function descriptiveName(...)\`
- Return ONLY TypeScript code — no markdown fences, no explanation`;

// ─── Streaming AI generation (SSE) ──────────────────────────────────

const CODE_ONLY_RULE = `

CRITICAL OUTPUT RULE: Your response must contain ONLY valid TypeScript code. No English text, no explanations, no markdown fences, no comments about what you changed, no preamble, no postamble. Start your response with an import statement or a comment that is part of the code. If you include ANY natural language text outside of code comments, the system will break.`;

function buildSystemPrompt(currentCode?: string, refine?: boolean): string {
  if (currentCode) {
    return `${SYSTEM_PROMPT}${CODE_ONLY_RULE}

Current code:
\`\`\`typescript
${currentCode}
\`\`\`

${refine ? "Apply the user's requested changes. Return the COMPLETE updated file." : "Modify the existing code based on the user's request. Return the complete updated code."}`;
  }
  return `${SYSTEM_PROMPT}${CODE_ONLY_RULE}

Generate complete Act TypeScript code from scratch.`;
}

function stripFences(code: string): string {
  let result = code.replace(/```(?:typescript|ts)?\s*\n/g, "");
  result = result.replace(/\n?```\s*$/g, "");
  // Strip leading natural language before the first code line
  result = result.replace(
    /^[\s\S]*?(?=\/\*\*|\/\/|import\b|export\b|const\b|let\b|var\b|type\b|interface\b|function\b)/,
    ""
  );
  // Strip trailing natural language after the last code-like line
  // Find the last line ending with ; } ) or a block comment close
  const lines = result.split("\n");
  let lastCodeLine = lines.length - 1;
  while (lastCodeLine > 0) {
    const trimmed = lines[lastCodeLine].trim();
    if (trimmed && /[;{})\]:]$|^\s*\/\/|^\s*\*\/|^\s*\*|^$/.test(trimmed))
      break;
    lastCodeLine--;
  }
  if (lastCodeLine < lines.length - 1) {
    result = lines.slice(0, lastCodeLine + 1).join("\n");
  }
  return result.trim();
}

export function streamGenerate(
  input: {
    prompt: string;
    currentCode?: string;
    maxTokens?: number;
    model?: string;
    refine?: boolean;
  },
  res: import("http").ServerResponse
) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("ANTHROPIC_API_KEY not set");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const client = new Anthropic({ apiKey });
  const stream = client.messages.stream({
    model: input.model || DEFAULT_MODELS[0].id,
    max_tokens: input.maxTokens || 16384,
    system: buildSystemPrompt(input.currentCode, input.refine),
    messages: [{ role: "user", content: input.prompt }],
  });

  stream.on("text", (text) => {
    res.write(`data: ${JSON.stringify({ type: "text", text })}\n\n`);
  });

  stream.on("finalMessage", (msg) => {
    const truncated = msg.stop_reason === "max_tokens";
    const usage = msg.usage;
    res.write(
      `data: ${JSON.stringify({ type: "done", truncated, usage })}\n\n`
    );
    res.end();
  });

  stream.on("error", (err) => {
    res.write(
      `data: ${JSON.stringify({ type: "error", message: (err as Error).message })}\n\n`
    );
    res.end();
  });
}

// ─── Configuration ──────────────────────────────────────────────────

const DEFAULT_MODELS = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-opus-4-6", label: "Opus 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

function getModels(): { id: string; label: string }[] {
  const env = process.env.BUILDER_MODELS;
  if (!env) return DEFAULT_MODELS;
  // Format: "model-id:Label,model-id:Label"
  const parsed = env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":");
      return { id: id.trim(), label: label?.trim() || id.trim() };
    });
  return parsed.length > 0 ? parsed : DEFAULT_MODELS;
}

function getDefaultMaxTokens(): number {
  const env = process.env.BUILDER_MAX_TOKENS;
  return env ? parseInt(env, 10) || 16384 : 16384;
}

// ─── GitHub file fetching ──────────────────────────────────────────

export const builderRouter = t.router({
  /** Return available models and defaults (driven by .env) */
  config: t.procedure.query(() => ({
    models: getModels(),
    defaultModel: getModels()[0].id,
    defaultMaxTokens: getDefaultMaxTokens(),
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
  })),

  /** Generate Act code from natural language prompt using Claude API */
  generate: t.procedure
    .input(
      z.object({
        prompt: z.string().min(1),
        currentCode: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(
          "ANTHROPIC_API_KEY not set. Export it before starting the builder server.",
          { cause: "missing_key" }
        );
      }

      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: DEFAULT_MODELS[0].id,
        max_tokens: 16384,
        system: buildSystemPrompt(input.currentCode),
        messages: [{ role: "user", content: input.prompt }],
      });

      const textBlock = response.content.find((b) => b.type === "text");
      return { code: stripFences(textBlock?.text ?? "") };
    }),

  /** Fetch source files from a GitHub repo, following local imports */
  fetchFromGit: t.procedure
    .input(
      z.object({
        owner: z.string(),
        repo: z.string(),
        branch: z.string().default("master"),
        entryPath: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { owner, repo, branch } = input;
      const { execSync } = await import("child_process");
      const { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } =
        await import("fs");
      const { join, relative } = await import("path");
      const { tmpdir } = await import("os");

      // Clone repo to temp directory (shallow clone for speed)
      const tmpDir = mkdtempSync(join(tmpdir(), "act-builder-"));
      try {
        const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
        const cloneUrl = ghToken
          ? `https://${ghToken}@github.com/${owner}/${repo}.git`
          : `https://github.com/${owner}/${repo}.git`;
        execSync(
          `git clone --depth 1 --branch ${branch} ${cloneUrl} ${tmpDir}/repo`,
          { stdio: "pipe", timeout: 30000 }
        );
        const repoDir = join(tmpDir, "repo");

        // Collect source and config files (no npm install — types come from
        // workspace package wiring on the client side)
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

        // Find ALL act() builder entry points in the repo
        const entryPaths: string[] = [];
        const skipPaths =
          /(?:__tests__|\/test\/|\.test\.|\.spec\.|\.bench\.|node_modules|dist\/|\.d\.ts$|\/inspector\/|\/builder\/)/;
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

        // Follow imports from ALL entry points, merging dependency trees.
        // Every file reachable via import chain is included — isDomainFile
        // is only used as a fallback when no act() entry is found.
        const collected = new Map<string, string>();
        const queue = [...entryPaths];

        while (queue.length > 0) {
          const filePath = queue.shift()!;
          if (collected.has(filePath)) continue;
          const content = tsFiles.get(filePath);
          if (!content) continue;
          collected.set(filePath, content);

          // Follow imports and re-exports
          const importRe =
            /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+)?from\s+["']([^"']+)["']/g;
          let m: RegExpExecArray | null;
          while ((m = importRe.exec(content)) !== null) {
            if (/^import\s+type\s/.test(m[0])) continue;
            const imp = m[1];

            if (imp.startsWith(".")) {
              // Relative import
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
                // Try file.ts then file/index.ts
                if (tsFiles.has(rp + ".ts")) queue.push(rp + ".ts");
                else if (tsFiles.has(rp + "/index.ts"))
                  queue.push(rp + "/index.ts");
              } else {
                queue.push(rp);
              }
            } else if (imp.startsWith("@") && !imp.startsWith("@rotorsoft/")) {
              // Workspace package: @scope/name → packages/name/src/index.ts
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

        // Merge config files (package.json, tsconfig, yaml) from repo — skip large doc files
        const CONFIG_RE =
          /(?:package\.json|tsconfig[^/]*\.json|pnpm-workspace\.yaml|\.npmrc)$/;
        for (const [path, content] of allRepoFiles) {
          if (!collected.has(path) && CONFIG_RE.test(path)) {
            collected.set(path, content);
          }
        }

        const files = [...collected.entries()].map(([path, content]) => ({
          path,
          content,
        }));

        return { files };
      } finally {
        // Clean up temp directory
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // best effort cleanup
        }
      }
    }),
});

export type BuilderRouter = typeof builderRouter;
