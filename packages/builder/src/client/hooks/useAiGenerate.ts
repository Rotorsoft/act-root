import { useCallback, useRef, useState } from "react";
import { stripFences } from "../lib/strip-fences.js";
import { trpc } from "../trpc.js";
import type { FileTab } from "../types/index.js";

export interface AiGenerateContext {
  promptInput: string;
  files: FileTab[];
  tsFiles: FileTab[];
  showDialog: boolean;
}

export interface AiGenerateCallbacks {
  onFreshStart: (projectName: string) => void;
  onCodeStreaming: (code: string) => void;
  onComplete: (
    finalCode: string,
    isRefine: boolean,
    truncated: boolean
  ) => void;
  onClearPrompt: () => void;
}

export interface UseAiGenerateReturn {
  generating: boolean;
  generateError: string | null;
  streamingCode: string;
  tokenUsage: { input: number; output: number } | null;
  aiModel: string | null;
  setAiModel: (model: string | null) => void;
  aiMaxTokens: number | null;
  setAiMaxTokens: (tokens: number | null) => void;
  effectiveModel: string;
  effectiveMaxTokens: number;
  handleGenerate: () => Promise<void>;
  config:
    | {
        defaultModel?: string;
        defaultMaxTokens?: number;
        models?: { id: string; label: string }[];
      }
    | undefined;
}

export function useAiGenerate(
  context: () => AiGenerateContext,
  callbacks: AiGenerateCallbacks
): UseAiGenerateReturn {
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [streamingCode, setStreamingCode] = useState("");
  const [tokenUsage, setTokenUsage] = useState<{
    input: number;
    output: number;
  } | null>(null);

  const configQuery = trpc.config.useQuery();
  const config = configQuery.data;
  const [aiMaxTokens, setAiMaxTokens] = useState<number | null>(null);
  const [aiModel, setAiModel] = useState<string | null>(null);
  const effectiveModel = aiModel ?? config?.defaultModel ?? "claude-sonnet-4-6";
  const effectiveMaxTokens = aiMaxTokens ?? config?.defaultMaxTokens ?? 16384;

  // ── Batched streaming updates via RAF (same pattern as NpmTerminal) ──
  const pendingCodeRef = useRef<string | null>(null);
  const rafRef = useRef(0);

  const flushStreaming = useCallback(
    (isRefine: boolean) => {
      rafRef.current = 0;
      const code = pendingCodeRef.current;
      if (code === null) return;
      pendingCodeRef.current = null;
      setStreamingCode(code);
      if (!isRefine) {
        callbacks.onCodeStreaming(code);
      }
    },
    [callbacks]
  );

  const handleGenerate = useCallback(async () => {
    const { promptInput, tsFiles, files, showDialog } = context();
    const trimmed = promptInput.trim();
    if (!trimmed) return;
    setGenerating(true);
    setGenerateError(null);
    setStreamingCode("");
    setTokenUsage(null);
    pendingCodeRef.current = null;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }

    const isRefine = files.length > 0 && !showDialog;
    if (!isRefine) {
      callbacks.onFreshStart(trimmed);
    }

    try {
      const apiUrl =
        (import.meta.env.VITE_API_URL as string) || "http://localhost:4002";
      const res = await fetch(`${apiUrl}/generate-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: trimmed,
          currentCode: tsFiles.map((f) => f.content).join("\n\n") || undefined,
          maxTokens: effectiveMaxTokens,
          model: effectiveModel,
          refine: isRefine,
        }),
      });
      if (!res.ok) throw new Error(await res.text());

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let code = "";
      let buffer = "";
      let truncated = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6));
          if (event.type === "text") {
            code += event.text;
            // Batch: store pending code and schedule a single RAF flush
            pendingCodeRef.current = code;
            if (!rafRef.current) {
              rafRef.current = requestAnimationFrame(() =>
                flushStreaming(isRefine)
              );
            }
          } else if (event.type === "done") {
            truncated = event.truncated ?? false;
            if (event.usage) {
              setTokenUsage({
                input: event.usage.input_tokens ?? 0,
                output: event.usage.output_tokens ?? 0,
              });
            }
          } else if (event.type === "error") {
            throw new Error(event.message as string);
          }
        }
      }
      // Flush any remaining pending code before completion
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      if (pendingCodeRef.current !== null) {
        setStreamingCode(pendingCodeRef.current);
        if (!isRefine) callbacks.onCodeStreaming(pendingCodeRef.current);
        pendingCodeRef.current = null;
      }
      const finalCode = stripFences(code);
      callbacks.onComplete(finalCode, isRefine, truncated);
      setStreamingCode("");
      callbacks.onClearPrompt();
      if (truncated) {
        setGenerateError(
          "Response was truncated — the generated code may be incomplete. Try a simpler prompt or refine the existing code."
        );
      }
    } catch (err: unknown) {
      setGenerateError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    }
  }, [context, callbacks, effectiveMaxTokens, effectiveModel, flushStreaming]);

  return {
    generating,
    generateError,
    streamingCode,
    tokenUsage,
    aiModel,
    setAiModel,
    aiMaxTokens,
    setAiMaxTokens,
    effectiveModel,
    effectiveMaxTokens,
    handleGenerate,
    config,
  };
}
