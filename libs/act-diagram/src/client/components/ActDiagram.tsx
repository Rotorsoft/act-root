import { useCallback, useEffect, useRef, useState } from "react";
import { extractModel } from "../lib/evaluate.js";
import { navigateToCode } from "../lib/navigate.js";
import { validate } from "../lib/validate.js";
import type {
  DomainModel,
  FileTab,
  HostMessage,
  ValidationWarning,
} from "../types/index.js";
import { AiBar, type AiOptions } from "./AiBar.js";
import { Diagram } from "./Diagram.js";

const emptyModel: DomainModel = {
  entries: [],
  states: [],
  slices: [],
  projections: [],
  reactions: [],
};

/** Debounced model extraction with fallback to last good model */
function useExtractModel(files: FileTab[]) {
  const [result, setResult] = useState<{
    model: DomainModel;
    warnings: ValidationWarning[];
  }>({ model: emptyModel, warnings: [] });
  const lastGoodRef = useRef<{
    model: DomainModel;
    warnings: ValidationWarning[];
  } | null>(null);

  useEffect(() => {
    if (files.length === 0) {
      lastGoodRef.current = null;
      setResult({ model: emptyModel, warnings: [] });
      return;
    }

    // Debounce: wait for file changes to settle before extracting
    const timer = setTimeout(() => {
      const { model, error } = extractModel(files);
      const warnings = validate(model);

      // Check if the model has errors (slice errors or global error)
      const hasErrors = !!error || model.slices.some((s) => !!s.error);

      if (!hasErrors) {
        // Good extraction — update and save as fallback
        const next = { model, warnings };
        lastGoodRef.current = next;
        setResult(next);
      } else if (lastGoodRef.current) {
        // Errors during extraction — keep showing last good model
        // (transient errors from files being created/deleted/changed)
        // Don't update state — the diagram stays stable
      } else {
        // No last good model — show errors (first load or persistent errors)
        setResult({ model, warnings });
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [files]);

  return result;
}

type Props = {
  /** Direct file injection */
  files?: FileTab[];
  /** Called when a diagram element is clicked — provides file:line:col and element type */
  onNavigate?: (file: string, line: number, col: number, type?: string) => void;
  /** Listen to postMessage for HostMessage updates */
  usePostMessage?: boolean;
  /** Optional AI callback */
  onAiRequest?: (prompt: string, files: FileTab[], options: AiOptions) => void;
  /** Whether AI is generating */
  generating?: boolean;
};

export function ActDiagram({
  files: propFiles,
  onNavigate,
  usePostMessage,
  onAiRequest,
  generating,
}: Props) {
  const [msgFiles, setMsgFiles] = useState<FileTab[]>([]);
  const files = propFiles ?? msgFiles;

  // PostMessage listener for IDE integration
  useEffect(() => {
    if (!usePostMessage) return;
    const handler = (e: MessageEvent) => {
      const msg = e.data as HostMessage;
      if (!msg?.type) return;
      switch (msg.type) {
        case "files":
          setMsgFiles(msg.files);
          break;
        case "fileAdded":
          setMsgFiles((prev) => [
            ...prev,
            { path: msg.path, content: msg.content },
          ]);
          break;
        case "fileChanged":
          setMsgFiles((prev) => {
            const idx = prev.findIndex((f) => f.path === msg.path);
            if (idx < 0) return prev;
            const next = [...prev];
            next[idx] = { path: msg.path, content: msg.content };
            return next;
          });
          break;
        case "fileDeleted":
          setMsgFiles((prev) => prev.filter((f) => f.path !== msg.path));
          break;
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [usePostMessage]);

  const { model, warnings } = useExtractModel(files);

  const handleClick = useCallback(
    (name: string, type?: string, file?: string) => {
      if (!onNavigate) return;
      const result = navigateToCode(files, name, type, file);
      if (result) onNavigate(result.file, result.line, result.col, type);
    },
    [files, onNavigate]
  );

  return (
    <div className="flex h-full flex-col">
      {onAiRequest && (
        <AiBar
          onSubmit={(prompt, options) => onAiRequest(prompt, files, options)}
          generating={generating}
        />
      )}
      <Diagram
        model={model}
        warnings={warnings}
        onClickElement={handleClick}
        onFixWithAi={
          onAiRequest
            ? (prompt) =>
                onAiRequest(prompt, files, {
                  model: "claude-sonnet-4-6",
                  maxTokens: 16384,
                })
            : undefined
        }
      />
    </div>
  );
}
