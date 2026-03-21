import { useCallback, useEffect, useMemo, useState } from "react";
import { extractModel } from "../lib/evaluate.js";
import { navigateToCode } from "../lib/navigate.js";
import { validate } from "../lib/validate.js";
import type {
  DomainModel,
  FileTab,
  HostMessage,
  ValidationWarning,
} from "../types/index.js";
import { AiBar } from "./AiBar.js";
import { Diagram } from "./Diagram.js";

type Props = {
  /** Direct file injection */
  files?: FileTab[];
  /** Called when a diagram element is clicked — provides file:line:col */
  onNavigate?: (file: string, line: number, col: number) => void;
  /** Listen to postMessage for HostMessage updates */
  usePostMessage?: boolean;
  /** Optional AI callback */
  onAiRequest?: (prompt: string, files: FileTab[]) => void;
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
        case "fileChanged":
          setMsgFiles((prev) => {
            const idx = prev.findIndex((f) => f.path === msg.path);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = { path: msg.path, content: msg.content };
              return next;
            }
            return [...prev, { path: msg.path, content: msg.content }];
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

  const { model, warnings } = useMemo(() => {
    if (files.length === 0)
      return {
        model: {
          entries: [],
          states: [],
          slices: [],
          projections: [],
          reactions: [],
        } as DomainModel,
        warnings: [] as ValidationWarning[],
      };
    const { model } = extractModel(files);
    const warnings = validate(model);
    return { model, warnings };
  }, [files]);

  const handleClick = useCallback(
    (name: string, type?: string, file?: string) => {
      if (!onNavigate) return;
      const result = navigateToCode(files, name, type, file);
      if (result) onNavigate(result.file, result.line, result.col);
    },
    [files, onNavigate]
  );

  return (
    <div className="flex h-full flex-col">
      {onAiRequest && (
        <AiBar
          onSubmit={(prompt) => onAiRequest(prompt, files)}
          generating={generating}
        />
      )}
      <Diagram model={model} warnings={warnings} onClickElement={handleClick} />
    </div>
  );
}
