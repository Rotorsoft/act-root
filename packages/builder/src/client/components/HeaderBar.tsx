import {
  AlertTriangle,
  Download,
  FolderOpen,
  Loader2,
  Plus,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import { Chip } from "./Chip.js";
import { GithubIcon } from "./GithubIcon.js";
import { Logo } from "./Logo.js";
import { Tooltip } from "./Tooltip.js";

export type HeaderBarProps = {
  projectName: string;
  projectSource: "sample" | "local" | "github" | "ai" | "";
  clearProject: () => void;
  generating: boolean;
  streamingCode: string;
  tokenUsage: { input: number; output: number } | null;
  generateError: string | null;
  warnings: { message: string; severity: string }[];
  filesExist: boolean;
  showInlinePrompt: boolean;
  onToggleInlinePrompt: () => void;
  editorErrorCount: number;
  appendErrors: () => void;
  onDownload: () => void;
};

export function HeaderBar({
  projectName,
  projectSource,
  clearProject,
  generating,
  streamingCode,
  tokenUsage,
  generateError,
  warnings,
  filesExist,
  showInlinePrompt,
  onToggleInlinePrompt,
  editorErrorCount,
  appendErrors,
  onDownload,
}: HeaderBarProps) {
  let projectIcon: ReactNode = null;
  if (projectSource === "sample")
    projectIcon = <Plus size={10} className="text-blue-400" />;
  else if (projectSource === "local")
    projectIcon = <FolderOpen size={10} className="text-cyan-400" />;
  else if (projectSource === "github")
    projectIcon = (
      <span className="text-emerald-400">
        <GithubIcon size={10} />
      </span>
    );
  else if (projectSource === "ai")
    projectIcon = <Sparkles size={10} className="text-purple-400" />;

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-925 px-4">
      <Logo size={20} />
      <span className="text-sm font-semibold tracking-wide text-zinc-300">
        Act Builder
      </span>
      {projectName && (
        <Chip
          icon={projectIcon}
          label={projectName}
          onClose={clearProject}
          closeTooltip="Close project"
        />
      )}
      <div className="ml-auto flex items-center gap-2">
        {generating && (
          <span className="flex items-center gap-1.5 text-[10px] text-purple-400">
            <Loader2 size={11} className="animate-spin" />
            Generating
            {streamingCode
              ? ` (${Math.round(streamingCode.length / 4)} tokens)`
              : ""}
            ...
          </span>
        )}
        {!generating && tokenUsage && (
          <span className="text-[10px] text-zinc-600">
            {tokenUsage.input.toLocaleString()}in /{" "}
            {tokenUsage.output.toLocaleString()}out tokens
          </span>
        )}
        {!generating && generateError && (
          <span className="flex items-center gap-1 text-[10px] text-amber-400">
            <AlertTriangle size={11} />
            {generateError}
          </span>
        )}
        {warnings.length > 0 && (
          <span className="flex items-center gap-1 text-[10px] text-amber-400">
            <AlertTriangle size={11} />
            {warnings.length}
          </span>
        )}
        {filesExist && (
          <>
            <Tooltip
              title="Refine with AI"
              description="Send a prompt to modify the current code"
              align="right"
            >
              <button
                onClick={onToggleInlinePrompt}
                className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] transition ${
                  showInlinePrompt
                    ? "border-purple-600 bg-purple-950/30 text-purple-400"
                    : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300"
                }`}
              >
                <Sparkles size={13} />
              </button>
            </Tooltip>
            {editorErrorCount > 0 && (
              <Tooltip
                title="TypeScript errors"
                description="Click to append errors to the AI refine prompt"
                align="right"
              >
                <button
                  onClick={appendErrors}
                  className="flex items-center gap-1 rounded-md border border-red-900/50 bg-red-950/20 px-2 py-1 text-[10px] text-red-400 transition hover:border-red-700 hover:bg-red-950/40"
                >
                  <AlertTriangle size={11} />
                  {editorErrorCount}
                </button>
              </Tooltip>
            )}
          </>
        )}
        <Tooltip
          title="Download Project"
          description="Zip archive with all project files"
          align="right"
        >
          <button
            onClick={onDownload}
            disabled={!filesExist}
            className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-[10px] text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-300 disabled:opacity-30"
          >
            <Download size={13} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
