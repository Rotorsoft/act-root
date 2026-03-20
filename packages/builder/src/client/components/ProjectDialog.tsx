import { FolderOpen, Info, Loader2, Plus, Send, Sparkles } from "lucide-react";
import type { SavedImport } from "../lib/github.js";
import type { SavedFolder } from "../lib/local-folder.js";
import { Chip } from "./Chip.js";
import { GithubIcon } from "./GithubIcon.js";
import { Logo } from "./Logo.js";
import { Tooltip } from "./Tooltip.js";

export type ProjectDialogProps = {
  // Sub-form visibility
  showGitImport: boolean;
  showPrompt: boolean;
  onShowGitImport: (show: boolean) => void;
  onShowPrompt: (show: boolean) => void;

  // Loading overlay
  clonePending: boolean;
  localLoading: boolean;
  cloneLog: string[];

  // Sample
  onLoadSample: () => void;

  // Local folder
  canOpenLocal: boolean;
  onOpenLocal: () => void;
  localError: string | null;
  savedFolders: SavedFolder[];
  onReopenFolder: (saved: SavedFolder) => void;
  onRemoveSavedFolder: (name: string) => void;

  // Git import
  gitUrl: string;
  onGitUrlChange: (url: string) => void;
  onGitFetch: () => void;
  cloneError: string | null;
  savedImports: SavedImport[];
  onCloneSavedImport: (saved: SavedImport) => void;
  onRemoveSavedImport: (url: string) => void;

  // AI prompt
  promptInput: string;
  onPromptInputChange: (value: string) => void;
  onGenerate: () => void;
  generating: boolean;
  generateError: string | null;
  promptTemplates: { label: string; prompt: string }[];
  effectiveModel: string;
  onModelChange: (model: string) => void;
  effectiveMaxTokens: number;
  onMaxTokensChange: (tokens: number) => void;
  models: { id: string; label: string }[];
};

export function ProjectDialog({
  showGitImport,
  showPrompt,
  onShowGitImport,
  onShowPrompt,
  clonePending,
  localLoading,
  cloneLog,
  onLoadSample,
  canOpenLocal,
  onOpenLocal,
  localError,
  savedFolders,
  onReopenFolder,
  onRemoveSavedFolder,
  gitUrl,
  onGitUrlChange,
  onGitFetch,
  cloneError,
  savedImports,
  onCloneSavedImport,
  onRemoveSavedImport,
  promptInput,
  onPromptInputChange,
  onGenerate,
  generating,
  generateError,
  promptTemplates,
  effectiveModel,
  onModelChange,
  effectiveMaxTokens,
  onMaxTokensChange,
  models,
}: ProjectDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-925 p-6 shadow-2xl">
        {(clonePending || localLoading) && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-2xl bg-zinc-925/90">
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <Loader2 size={16} className="animate-spin" />
              {localLoading ? "Reading folder..." : "Importing repository..."}
            </div>
            {cloneLog.length > 0 && (
              <div className="max-h-48 w-full max-w-md overflow-auto rounded border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-500">
                {cloneLog.map((line, i) => (
                  <div key={i}>
                    <span className="text-zinc-700 select-none">
                      {"\u25B8 "}
                    </span>
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="mb-5 flex items-center gap-2">
          {showGitImport ? (
            <span className="text-emerald-400">
              <GithubIcon size={24} />
            </span>
          ) : showPrompt ? (
            <Sparkles size={24} className="text-purple-400" />
          ) : (
            <Logo size={24} />
          )}
          <span className="text-base font-semibold text-zinc-200">
            {showGitImport
              ? "Import from GitHub"
              : showPrompt
                ? "Generate with AI"
                : "Act Builder"}
          </span>
        </div>

        {/* Option cards */}
        {!showGitImport && !showPrompt && (
          <div>
            <div className="grid grid-cols-4 gap-3">
              {/* ── Todo App ── */}
              <div className="relative flex">
                <button
                  onClick={onLoadSample}
                  className="group flex flex-1 flex-col items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 py-6 transition hover:border-blue-600 hover:bg-blue-950/20"
                >
                  <Plus
                    size={24}
                    className="text-zinc-600 transition group-hover:text-blue-400"
                  />
                  <span className="text-xs font-medium text-zinc-400 transition group-hover:text-blue-400">
                    Todo App
                  </span>
                  <span className="text-[9px] text-zinc-600">
                    Sample project
                  </span>
                </button>
                <div className="absolute right-1.5 top-1.5">
                  <Tooltip
                    title="Sample Project"
                    details={[
                      {
                        label: "Source",
                        text: "Built-in Todo + Notification app with states, slices, projections, and orchestrator",
                      },
                      {
                        label: "Storage",
                        text: "In-memory in the browser — nothing is written to disk",
                      },
                      {
                        label: "Editing",
                        text: "Edit code live, diagram updates in real time",
                      },
                      {
                        label: "Export",
                        text: "Download button generates act-app.sh that recreates the project locally",
                      },
                    ]}
                    position="bottom"
                    align="left"
                  >
                    <Info
                      size={12}
                      className="text-zinc-700 transition hover:text-blue-400"
                    />
                  </Tooltip>
                </div>
              </div>

              {/* ── Open Local ── */}
              <div className="relative flex">
                <button
                  onClick={onOpenLocal}
                  disabled={!canOpenLocal || localLoading}
                  className="group flex flex-1 flex-col items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 py-6 transition hover:border-cyan-600 hover:bg-cyan-950/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {localLoading ? (
                    <Loader2 size={24} className="animate-spin text-cyan-400" />
                  ) : (
                    <FolderOpen
                      size={24}
                      className="text-zinc-600 transition group-hover:text-cyan-400"
                    />
                  )}
                  <span className="text-xs font-medium text-zinc-400 transition group-hover:text-cyan-400">
                    Open Local
                  </span>
                  <span className="text-[9px] text-zinc-600">
                    {canOpenLocal ? "Browse folder" : "Chrome/Edge only"}
                  </span>
                </button>
                <div className="absolute right-1.5 top-1.5">
                  <Tooltip
                    title="Open Local Folder"
                    details={[
                      {
                        label: "How",
                        text: "Uses the browser File System Access API to read .ts/.tsx files directly from a local folder",
                      },
                      {
                        label: "Filtering",
                        text: "Finds act() entry points and follows imports to collect domain files — infrastructure files are excluded",
                      },
                      {
                        label: "Access",
                        text: "Read-only — your local files are never modified",
                      },
                      {
                        label: "History",
                        text: "Recently opened folders are remembered and can be reopened with a single click (browser will ask to re-confirm access)",
                      },
                      {
                        label: "Browser",
                        text: "Requires Chrome, Edge, or Opera (not available in Firefox or Safari)",
                      },
                      {
                        label: "Export",
                        text: "Download button generates act-app.sh with the loaded files",
                      },
                    ]}
                    position="bottom"
                    align="left"
                  >
                    <Info
                      size={12}
                      className="text-zinc-700 transition hover:text-cyan-400"
                    />
                  </Tooltip>
                </div>
              </div>

              {/* ── GitHub Import ── */}
              <div className="relative flex">
                <button
                  onClick={() => onShowGitImport(true)}
                  className="group flex flex-1 flex-col items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 py-6 transition hover:border-emerald-600 hover:bg-emerald-950/20"
                >
                  <span className="text-zinc-600 transition group-hover:text-emerald-400">
                    <GithubIcon size={24} />
                  </span>
                  <span className="text-xs font-medium text-zinc-400 transition group-hover:text-emerald-400">
                    Import
                  </span>
                  <span className="text-[9px] text-zinc-600">
                    Clone from GitHub
                  </span>
                </button>
                <div className="absolute right-1.5 top-1.5">
                  <Tooltip
                    title="GitHub Import"
                    details={[
                      {
                        label: "How",
                        text: "Shallow-clones the repo (--depth 1) to a server temp directory, then extracts domain files",
                      },
                      {
                        label: "Filtering",
                        text: "Finds act() entry points and follows imports — infrastructure files (db, http, etc.) are excluded",
                      },
                      {
                        label: "Auth",
                        text: "Set GITHUB_TOKEN or GH_TOKEN env var on the server for private repos",
                      },
                      {
                        label: "History",
                        text: "Previously imported repos are saved as quick-access chips for one-click re-import",
                      },
                      {
                        label: "Cleanup",
                        text: "Temp directory is deleted after files are extracted",
                      },
                      {
                        label: "Export",
                        text: "Download button generates act-app.sh with the imported files",
                      },
                    ]}
                    position="bottom"
                    align="right"
                  >
                    <Info
                      size={12}
                      className="text-zinc-700 transition hover:text-emerald-400"
                    />
                  </Tooltip>
                </div>
              </div>

              {/* ── AI Generate ── */}
              <div className="relative flex">
                <button
                  onClick={() => onShowPrompt(true)}
                  className="group flex flex-1 flex-col items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 py-6 transition hover:border-purple-600 hover:bg-purple-950/20"
                >
                  <Sparkles
                    size={24}
                    className="text-zinc-600 transition group-hover:text-purple-400"
                  />
                  <span className="text-xs font-medium text-zinc-400 transition group-hover:text-purple-400">
                    AI Generate
                  </span>
                  <span className="text-[9px] text-zinc-600">
                    Describe your domain
                  </span>
                </button>
                <div className="absolute right-1.5 top-1.5">
                  <Tooltip
                    title="AI Code Generation"
                    details={[
                      {
                        label: "How",
                        text: "Sends your prompt to the Claude API and generates a complete Act application",
                      },
                      {
                        label: "Auth",
                        text: "Requires ANTHROPIC_API_KEY env var on the server",
                      },
                      {
                        label: "Output",
                        text: "Generates a single src/app.ts with states, slices, projections, and orchestrator",
                      },
                      {
                        label: "Refine",
                        text: "If code is already loaded, the AI refines it based on your new prompt",
                      },
                      {
                        label: "Export",
                        text: "Download button generates act-app.sh — run it, git init, then reopen via Open Local to keep iterating",
                      },
                    ]}
                    position="bottom"
                    align="right"
                  >
                    <Info
                      size={12}
                      className="text-zinc-700 transition hover:text-purple-400"
                    />
                  </Tooltip>
                </div>
              </div>
            </div>

            {(savedImports.length > 0 ||
              (savedFolders.length > 0 && canOpenLocal)) && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="text-[9px] text-zinc-600">Recent:</span>
                {savedFolders.map((s) => (
                  <Chip
                    key={`local:${s.name}`}
                    icon={<FolderOpen size={9} className="text-cyan-400" />}
                    label={s.name}
                    onClick={() => onReopenFolder(s)}
                    onClose={() => onRemoveSavedFolder(s.name)}
                    closeTooltip={`Remove "${s.name}" from history`}
                    disabled={localLoading}
                    hoverClass="hover:border-cyan-700 hover:text-cyan-400"
                  />
                ))}
                {savedImports.map((s) => (
                  <Chip
                    key={`git:${s.url}`}
                    icon={
                      <span className="text-emerald-400">
                        <GithubIcon size={9} />
                      </span>
                    }
                    label={s.label}
                    onClick={() => onCloneSavedImport(s)}
                    onClose={() => onRemoveSavedImport(s.url)}
                    closeTooltip={`Remove "${s.label}" from history`}
                    hoverClass="hover:border-emerald-700 hover:text-emerald-400"
                  />
                ))}
              </div>
            )}

            {localError && (
              <div className="mt-3 text-[10px] text-red-400">{localError}</div>
            )}
          </div>
        )}

        {/* GitHub import form */}
        {showGitImport && (
          <div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                name="git-url"
                value={gitUrl}
                onChange={(e) => onGitUrlChange(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onGitFetch()}
                placeholder="https://github.com/owner/repo.git"
                className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-600"
                autoFocus
              />
              <button
                onClick={onGitFetch}
                disabled={clonePending || !gitUrl.trim()}
                className="flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
              >
                {clonePending ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <GithubIcon size={12} />
                )}
                Import
              </button>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => onShowGitImport(false)}
                className="rounded-md px-3 py-1.5 text-xs text-zinc-500 transition hover:text-zinc-300"
              >
                Back
              </button>
            </div>
            {cloneError && (
              <div className="mt-2 text-[10px] text-red-400">{cloneError}</div>
            )}
          </div>
        )}

        {/* AI prompt form */}
        {showPrompt && (
          <div>
            <div className="mb-2 flex items-center gap-1.5">
              {promptTemplates.map((pt) => (
                <button
                  key={pt.label}
                  onClick={() => onPromptInputChange(pt.prompt)}
                  className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[9px] text-zinc-400 transition hover:border-purple-700 hover:text-purple-400"
                >
                  {pt.label}
                </button>
              ))}
              <div className="ml-auto flex items-center gap-2">
                <select
                  value={effectiveModel}
                  onChange={(e) => onModelChange(e.target.value)}
                  className="rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400 outline-none"
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <select
                  value={effectiveMaxTokens}
                  onChange={(e) => onMaxTokensChange(Number(e.target.value))}
                  className="rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400 outline-none"
                >
                  <option value={4096}>4K tokens</option>
                  <option value={8192}>8K tokens</option>
                  <option value={16384}>16K tokens</option>
                  <option value={32768}>32K tokens</option>
                  <option value={65536}>64K tokens</option>
                </select>
              </div>
            </div>
            <textarea
              name="ai-prompt"
              value={promptInput}
              onChange={(e) => onPromptInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onGenerate();
                }
              }}
              placeholder="Describe your domain..."
              rows={3}
              className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-purple-600"
              autoFocus
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => onShowPrompt(false)}
                className="rounded-md px-3 py-1.5 text-xs text-zinc-500 transition hover:text-zinc-300"
              >
                Back
              </button>
              <button
                onClick={onGenerate}
                disabled={generating || !promptInput.trim()}
                className="flex items-center gap-1 rounded-md bg-purple-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-purple-500 disabled:opacity-50"
              >
                {generating ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Send size={12} />
                )}
                Generate
              </button>
            </div>
            {generateError && (
              <div className="mt-2 text-[10px] text-red-400">
                {generateError}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
