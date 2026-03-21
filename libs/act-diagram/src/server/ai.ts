import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// ─── Skill loading ───────────────────────────────────────────────────

function findSkillsDir(): string | null {
  const envDir = process.env.BUILDER_SKILLS_DIR;
  if (envDir && existsSync(envDir)) return envDir;

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

// ─── Prompt building ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert Act framework developer generating TypeScript code using @rotorsoft/act.

${SKILL_CONTENT ? `${SKILL_CONTENT}\n\n` : ""}${API_CONTENT ? `${API_CONTENT}\n\n` : ""}## Builder Output Rules
- Generate a MULTI-FILE project with proper folder structure
- Each file is wrapped in a path-annotated fenced block: \`\`\`typescript:src/filename.ts
- Typical structure:
  - src/states.ts — state definitions with events, actions, patches
  - src/slices.ts — slices wiring states with reactions
  - src/projection.ts — projections for read-model updates (if needed)
  - src/app.ts — orchestrator: act().withSlice(...).build()
- Import from "@rotorsoft/act" and "zod" only
- Add JSDoc comments explaining the domain model and key design decisions
- Name reaction handlers with \`async function descriptiveName(...)\``;

const CODE_ONLY_RULE = `

CRITICAL OUTPUT RULE: Your response must contain ONLY path-annotated fenced code blocks. No English text outside of code blocks. Example format:

\`\`\`typescript:src/states.ts
import { state } from "@rotorsoft/act";
// ... state definitions
\`\`\`

\`\`\`typescript:src/app.ts
import { act } from "@rotorsoft/act";
// ... orchestrator
\`\`\`

If you include ANY natural language text outside of code blocks, the system will break.`;

export function buildSystemPrompt(
  currentFiles?: { path: string; content: string }[],
  refine?: boolean
): string {
  if (currentFiles && currentFiles.length > 0) {
    const fileBlocks = currentFiles
      .filter(
        (f: { path: string }) =>
          !f.path.startsWith("node_modules/") && f.path.endsWith(".ts")
      )
      .map(
        (f: { path: string; content: string }) =>
          `\`\`\`typescript:${f.path}\n${f.content}\n\`\`\``
      )
      .join("\n\n");

    return `${SYSTEM_PROMPT}${CODE_ONLY_RULE}

Current project files:
${fileBlocks}

${refine ? "Apply the user's requested changes. Return ALL project files (even unchanged ones) as path-annotated blocks." : "Modify the project based on the user's request. Return ALL files as path-annotated blocks."}`;
  }
  return `${SYSTEM_PROMPT}${CODE_ONLY_RULE}

Generate a complete Act TypeScript project from scratch with proper multi-file structure.`;
}

// ─── Model configuration ─────────────────────────────────────────────

export const DEFAULT_MODELS = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-opus-4-6", label: "Opus 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

// ─── Streaming AI generation (SSE) ──────────────────────────────────

export function streamGenerate(
  input: {
    prompt: string;
    currentFiles?: { path: string; content: string }[];
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
    system: buildSystemPrompt(input.currentFiles, input.refine),
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
