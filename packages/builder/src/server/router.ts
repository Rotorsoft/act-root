import Anthropic from "@anthropic-ai/sdk";
import { initTRPC } from "@trpc/server";
import { z } from "zod";
import {
  buildSystemPrompt,
  DEFAULT_MODELS,
  getDefaultMaxTokens,
  getModels,
  stripFences,
} from "./ai.js";
import { cloneAndCollect } from "./git.js";

// Re-export SSE handlers for server.ts
export { streamGenerate } from "./ai.js";
export { streamFetchFromGit } from "./git.js";

const t = initTRPC.create();

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
    .mutation(({ input }) => {
      const { files } = cloneAndCollect(input);
      return { files };
    }),
});

export type BuilderRouter = typeof builderRouter;
