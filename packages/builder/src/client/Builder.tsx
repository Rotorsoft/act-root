import {
  AlertTriangle,
  Download,
  FolderOpen,
  Info,
  Loader2,
  Plus,
  Send,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chip } from "./components/Chip.js";
import { CodeEditor } from "./components/CodeEditor.js";
import { Diagram } from "./components/Diagram.js";
import { GithubIcon } from "./components/GithubIcon.js";
import { Logo } from "./components/Logo.js";
import { Tooltip } from "./components/Tooltip.js";
import { PROMPT_TEMPLATES } from "./data/prompts.js";
import { projectFiles, SAMPLE_APP } from "./data/sample-app.js";
import { downloadProject } from "./lib/download.js";
import { extractModel } from "./lib/evaluate.js";
import {
  loadSavedImports,
  parseGitUrl,
  removeSavedImport,
  repoLabel,
  saveImport,
  type SavedImport,
} from "./lib/github.js";
import {
  hasFileSystemAccess,
  loadSavedFolders,
  openLocalFolder,
  removeSavedFolder,
  reopenSavedFolder,
  type SavedFolder,
} from "./lib/local-folder.js";
import { deriveProjectName, stripFences } from "./lib/strip-fences.js";
import { validate } from "./lib/validate.js";
import {
  getWorkspaceErrors,
  openFileInEditor,
  revealWord,
} from "./lib/vscode-init.js";
import { trpc } from "./trpc.js";
import type { FileTab } from "./types/index.js";
import { emptyModel } from "./types/index.js";

export function Builder() {
  const [files, setFiles] = useState<FileTab[]>([]);
  const [promptInput, setPromptInput] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [showGitImport, setShowGitImport] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [savedImports, setSavedImports] =
    useState<SavedImport[]>(loadSavedImports);
  const [splitPct, setSplitPct] = useState(50);
  const isDragging = useRef(false);
  const [projectName, setProjectName] = useState("");
  const [showDialog, setShowDialog] = useState(true);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [savedFolders, setSavedFolders] = useState<SavedFolder[]>([]);

  // Load saved folders from IndexedDB on mount
  useEffect(() => {
    void loadSavedFolders().then(setSavedFolders);
  }, []);

  const tsFiles = files.filter(
    (f) => f.path.endsWith(".ts") || f.path.endsWith(".tsx")
  );

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

  const fetchMutation = trpc.fetchFromGit.useMutation({
    onMutate: () => {
      setFiles([]);
      setEditorErrorCount(0);
    },
    onSuccess: (result) => {
      setFiles(result.files);
      setShowGitImport(false);
      setShowPrompt(false);
      setShowDialog(false);
      if (gitUrl.trim()) {
        saveImport(gitUrl.trim());
        setSavedImports(loadSavedImports());
        setProjectName(repoLabel(gitUrl.trim()));
        setProjectSource("github");
      }
    },
  });

  const prevModelRef = useRef(emptyModel());
  const { model, evalError } = useMemo(() => {
    if (tsFiles.length === 0) {
      prevModelRef.current = emptyModel();
      return { model: emptyModel(), evalError: undefined };
    }
    let model: ReturnType<typeof extractModel>["model"];
    let error: ReturnType<typeof extractModel>["error"];
    try {
      ({ model, error } = extractModel(tsFiles));
    } catch (e) {
      return {
        model: prevModelRef.current,
        evalError: e instanceof Error ? e.message : String(e),
      };
    }
    if (error) {
      return { model: prevModelRef.current, evalError: error };
    }
    prevModelRef.current = model;
    return { model, evalError: undefined };
  }, [tsFiles]);

  const warnings = useMemo(() => {
    const w = validate(model);
    if (evalError) {
      w.unshift({ message: evalError, severity: "error" as const });
    }
    return w;
  }, [model, evalError]);

  const handleGitFetch = useCallback(() => {
    const parsed = parseGitUrl(gitUrl.trim());
    if (!parsed) return;
    fetchMutation.mutate({ ...parsed, entryPath: parsed.entryPath });
  }, [gitUrl, fetchMutation]);

  const handleGenerate = useCallback(async () => {
    const trimmed = promptInput.trim();
    if (!trimmed) return;
    setGenerating(true);
    setGenerateError(null);
    setStreamingCode("");
    setTokenUsage(null);

    const isRefine = files.length > 0 && !showDialog;
    if (!isRefine) {
      setFiles([
        { path: "src/app.ts", content: "" },
        ...projectFiles(projectName),
      ]);
      setShowPrompt(false);
      setShowDialog(false);
      setProjectName(deriveProjectName(trimmed));
      setProjectSource("ai");
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
            setStreamingCode(code);
            // Only update editor live for fresh generation, not refinement
            if (!isRefine) {
              setFiles((prev) => {
                const idx = prev.findIndex((f) => f.path.endsWith(".ts"));
                if (idx < 0)
                  return [{ path: "src/app.ts", content: code }, ...prev];
                return prev.map((f, i) =>
                  i === idx ? { ...f, content: code } : f
                );
              });
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
      // Apply final code
      const finalCode = stripFences(code);
      setFiles((prev) => {
        if (isRefine) {
          const idx = prev.findIndex((f) => f.path.endsWith(".ts"));
          if (idx >= 0)
            return prev.map((f, i) =>
              i === idx ? { ...f, content: finalCode } : f
            );
        }
        return [
          { path: "src/app.ts", content: finalCode },
          ...projectFiles(projectName),
        ];
      });
      setStreamingCode("");
      setPromptInput("");
      if (!isRefine) setProjectName(deriveProjectName(trimmed, finalCode));
      if (truncated) {
        setGenerateError(
          "Response was truncated — the generated code may be incomplete. Try a simpler prompt or refine the existing code."
        );
      }
    } catch (err: unknown) {
      setGenerateError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }, [
    promptInput,
    tsFiles,
    files,
    showDialog,
    projectName,
    effectiveMaxTokens,
    effectiveModel,
  ]);

  const handleLocalFolder = useCallback(async () => {
    setLocalError(null);
    setLocalLoading(true);
    setFiles([]);
    setEditorErrorCount(0);
    try {
      const { name, files: loaded } = await openLocalFolder();
      setFiles(loaded);
      setShowDialog(false);
      setProjectName(name);
      setProjectSource("local");
      setSavedFolders(await loadSavedFolders());
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // User cancelled the picker
      } else {
        setLocalError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLocalLoading(false);
    }
  }, []);

  const handleReopenFolder = useCallback(async (saved: SavedFolder) => {
    setLocalError(null);
    setLocalLoading(true);
    setFiles([]);
    setEditorErrorCount(0);
    try {
      const { name, files: loaded } = await reopenSavedFolder(saved);
      setFiles(loaded);
      setShowDialog(false);
      setProjectName(name);
      setProjectSource("local");
    } catch (err: unknown) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setLocalLoading(false);
    }
  }, []);

  const handleFileChange = useCallback((index: number, content: string) => {
    setFiles((prev) =>
      prev.map((f, i) => (i === index ? { ...f, content } : f))
    );
  }, []);

  const handleClickElement = useCallback(
    (name: string, type?: string) => {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      // Each pattern captures the name in group 1 so we can highlight the exact word
      const statePatterns = [
        new RegExp(`state\\(\\s*\\{\\s*(${esc})\\s*[}:,]`),
      ];
      const actionPatterns = [
        new RegExp(`\\.on\\(\\s*\\{\\s*(${esc})\\s*[},:]`),
      ];
      const eventPatterns = [
        new RegExp(`\\.emits\\(\\s*\\{[^}]*(${esc})\\s*:`),
        new RegExp(`\\.patch\\(\\s*\\{[^}]*(${esc})\\s*:`),
      ];
      const reactionPatterns = [
        new RegExp(`async\\s+function\\s+(${esc})\\s*\\(`),
        new RegExp(
          `\\.on\\(\\s*["'\`][^"'\`]+["'\`]\\s*\\)\\s*\\.do\\(\\s*(?:async\\s+)?function\\s+(${esc})\\b`
        ),
      ];
      const projectionPatterns = [
        new RegExp(`(?:const|let|var)\\s+(${esc})\\s*=\\s*projection\\s*\\(`),
        new RegExp(`projection\\(\\s*["'\`](${esc})["'\`]`),
      ];
      const guardPatterns = [
        // Match: description: "Guard text" inside an invariant object or .given() array
        new RegExp(`description:\\s*["'\`](${esc})["'\`]`),
        // Match: variable name if it's an invariant const
        new RegExp(`(?:const|let|var)\\s+(${esc})\\s*(?::\\s*Invariant)?\\s*=`),
        // Fallback: find the string inside .given()
        new RegExp(`\\.given\\(\\s*\\[[^\\]]*["'\`](${esc})["'\`]`),
      ];
      const slicePatterns = [
        new RegExp(`(?:const|let|var)\\s+(${esc})\\s*=\\s*slice\\s*\\(`),
      ];
      const generic = [
        new RegExp(
          `(?:const|let|var)\\s+(${esc})\\s*=\\s*(?:state|slice|projection|act)\\s*\\(`
        ),
        new RegExp(`(?:const|let|var)\\s+(${esc})\\s*=`),
        new RegExp(`\\b(${esc})\\b`),
      ];

      const patterns =
        type === "state"
          ? [...statePatterns, ...generic]
          : type === "action"
            ? [...actionPatterns, ...generic]
            : type === "event"
              ? [...eventPatterns, ...generic]
              : type === "reaction"
                ? [...reactionPatterns, ...generic]
                : type === "projection"
                  ? [...projectionPatterns, ...generic]
                  : type === "guard"
                    ? [...guardPatterns, ...generic]
                    : [
                        ...slicePatterns,
                        ...statePatterns,
                        ...actionPatterns,
                        ...eventPatterns,
                        ...reactionPatterns,
                        ...projectionPatterns,
                        ...guardPatterns,
                        ...generic,
                      ];

      for (const re of patterns) {
        for (let i = 0; i < files.length; i++) {
          if (!/\.tsx?$/.test(files[i].path)) continue;
          const match = re.exec(files[i].content);
          if (match) {
            // Locate the exact name within the match using the captured group
            const matchText = match[0];
            // Use the last occurrence of the name in the match (captured groups
            // tend to be at the end of the pattern prefix)
            const nameOffsetInMatch = matchText.lastIndexOf(name);
            const nameStart =
              nameOffsetInMatch >= 0
                ? match.index + nameOffsetInMatch
                : match.index;
            const before = files[i].content.slice(0, nameStart);
            const lastNl = before.lastIndexOf("\n");
            const line = before.split("\n").length;
            const col = nameStart - (lastNl >= 0 ? lastNl : 0);

            void openFileInEditor(files[i].path).then(() => {
              setTimeout(() => revealWord(line, col, name.length), 100);
            });
            return;
          }
        }
      }
    },
    [files]
  );

  const [projectSource, setProjectSource] = useState<
    "sample" | "local" | "github" | "ai" | ""
  >("");

  const loadSampleApp = useCallback(() => {
    setFiles(SAMPLE_APP);
    setProjectName("Todo App");
    setProjectSource("sample");
    setShowGitImport(false);
    setShowPrompt(false);
    setShowDialog(false);
  }, []);

  const [showInlinePrompt, setShowInlinePrompt] = useState(false);

  const clearProject = useCallback(() => {
    setFiles([]);
    setProjectName("");
    setProjectSource("");
    setGitUrl("");
    setShowGitImport(false);
    setShowPrompt(false);
    setShowDialog(true);
    setLocalError(null);
    setPromptInput("");
    setShowInlinePrompt(false);
    setGenerateError(null);
    setTokenUsage(null);
    setEditorErrorCount(0);
  }, []);

  const [editorErrorCount, setEditorErrorCount] = useState(0);

  // Poll Monaco markers for error count
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => {
    if (files.length === 0) {
      setEditorErrorCount(0);
      return;
    }
    const interval = setInterval(() => {
      if (filesRef.current.length === 0) return;
      setEditorErrorCount(getWorkspaceErrors().length);
    }, 2000);
    return () => clearInterval(interval);
  }, [files]);

  const appendErrors = useCallback(() => {
    const errors = getWorkspaceErrors();
    if (errors.length === 0) return;
    const errorBlock = errors.map((e) => `- ${e}`).join("\n");
    setPromptInput((prev) => {
      const base = prev.trim();
      return base
        ? `${base}\n\nFix these TypeScript errors:\n${errorBlock}`
        : `Fix these TypeScript errors:\n${errorBlock}`;
    });
    if (!showInlinePrompt) setShowInlinePrompt(true);
  }, [showInlinePrompt]);

  const canOpenLocal = hasFileSystemAccess();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-925 px-4">
        <Logo size={20} />
        <span className="text-sm font-semibold tracking-wide text-zinc-300">
          Act Builder
        </span>
        {projectName && (
          <Chip
            icon={
              projectSource === "sample" ? (
                <Plus size={10} className="text-blue-400" />
              ) : projectSource === "local" ? (
                <FolderOpen size={10} className="text-cyan-400" />
              ) : projectSource === "github" ? (
                <span className="text-emerald-400">
                  <GithubIcon size={10} />
                </span>
              ) : projectSource === "ai" ? (
                <Sparkles size={10} className="text-purple-400" />
              ) : null
            }
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
          {files.length > 0 && (
            <>
              <Tooltip
                title="Refine with AI"
                description="Send a prompt to modify the current code"
                align="right"
              >
                <button
                  onClick={() => setShowInlinePrompt((v) => !v)}
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
              onClick={() => downloadProject(files, projectName)}
              disabled={files.length === 0}
              className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-[10px] text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-300 disabled:opacity-30"
            >
              <Download size={13} />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* ── Project dialog (modal) ──────────────────────────────────── */}
      {showDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="relative w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-925 p-6 shadow-2xl">
            {(fetchMutation.isPending || localLoading) && (
              <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-zinc-925/80">
                <div className="flex items-center gap-2 text-sm text-zinc-400">
                  <Loader2 size={16} className="animate-spin" />
                  {localLoading ? "Reading folder..." : "Cloning repository..."}
                </div>
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
                      onClick={loadSampleApp}
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
                      onClick={handleLocalFolder}
                      disabled={!canOpenLocal || localLoading}
                      className="group flex flex-1 flex-col items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 py-6 transition hover:border-cyan-600 hover:bg-cyan-950/20 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {localLoading ? (
                        <Loader2
                          size={24}
                          className="animate-spin text-cyan-400"
                        />
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
                      onClick={() => setShowGitImport(true)}
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
                      onClick={() => setShowPrompt(true)}
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
                        onClick={() => handleReopenFolder(s)}
                        onClose={async () =>
                          setSavedFolders(await removeSavedFolder(s.name))
                        }
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
                        onClick={() => {
                          setGitUrl(s.url);
                          const parsed = parseGitUrl(s.url);
                          if (parsed)
                            fetchMutation.mutate({
                              ...parsed,
                              entryPath: parsed.entryPath,
                            });
                        }}
                        onClose={() =>
                          setSavedImports(removeSavedImport(s.url))
                        }
                        closeTooltip={`Remove "${s.label}" from history`}
                        hoverClass="hover:border-emerald-700 hover:text-emerald-400"
                      />
                    ))}
                  </div>
                )}

                {localError && (
                  <div className="mt-3 text-[10px] text-red-400">
                    {localError}
                  </div>
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
                    onChange={(e) => setGitUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleGitFetch()}
                    placeholder="https://github.com/owner/repo.git"
                    className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-600"
                    autoFocus
                  />
                  <button
                    onClick={handleGitFetch}
                    disabled={fetchMutation.isPending || !gitUrl.trim()}
                    className="flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {fetchMutation.isPending ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <GithubIcon size={12} />
                    )}
                    Import
                  </button>
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    onClick={() => setShowGitImport(false)}
                    className="rounded-md px-3 py-1.5 text-xs text-zinc-500 transition hover:text-zinc-300"
                  >
                    Back
                  </button>
                </div>
                {fetchMutation.error && (
                  <div className="mt-2 text-[10px] text-red-400">
                    {fetchMutation.error.message}
                  </div>
                )}
              </div>
            )}

            {/* AI prompt form */}
            {showPrompt && (
              <div>
                <div className="mb-2 flex items-center gap-1.5">
                  {PROMPT_TEMPLATES.map((pt) => (
                    <button
                      key={pt.label}
                      onClick={() => setPromptInput(pt.prompt)}
                      className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[9px] text-zinc-400 transition hover:border-purple-700 hover:text-purple-400"
                    >
                      {pt.label}
                    </button>
                  ))}
                  <div className="ml-auto flex items-center gap-2">
                    <select
                      value={effectiveModel}
                      onChange={(e) => setAiModel(e.target.value)}
                      className="rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400 outline-none"
                    >
                      {(
                        config?.models ?? [
                          { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
                        ]
                      ).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    <select
                      value={effectiveMaxTokens}
                      onChange={(e) => setAiMaxTokens(Number(e.target.value))}
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
                  onChange={(e) => setPromptInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleGenerate();
                    }
                  }}
                  placeholder="Describe your domain..."
                  rows={3}
                  className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-purple-600"
                  autoFocus
                />
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    onClick={() => setShowPrompt(false)}
                    className="rounded-md px-3 py-1.5 text-xs text-zinc-500 transition hover:text-zinc-300"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleGenerate}
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
      )}

      {/* Inline AI prompt bar */}
      {showInlinePrompt && files.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-925 px-4 py-1.5">
          <Sparkles
            size={13}
            className="mt-1 shrink-0 self-start text-purple-400"
          />
          <textarea
            value={promptInput}
            onChange={(e) => setPromptInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleGenerate();
              }
              if (e.key === "Escape") setShowInlinePrompt(false);
            }}
            placeholder="Refine the code... (Enter to send, Esc to close)"
            rows={Math.min(5, Math.max(1, promptInput.split("\n").length))}
            className="flex-1 resize-y rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-purple-600"
            autoFocus
          />
          <select
            value={effectiveModel}
            onChange={(e) => setAiModel(e.target.value)}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-[9px] text-zinc-400 outline-none"
          >
            {(
              config?.models ?? [
                { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
              ]
            ).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <button
            onClick={handleGenerate}
            disabled={generating || !promptInput.trim()}
            className="flex items-center gap-1 rounded-md bg-purple-600 px-3 py-1 text-[10px] font-medium text-white transition hover:bg-purple-500 disabled:opacity-50"
          >
            {generating ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Send size={11} />
            )}
            Refine
          </button>
        </div>
      )}

      {/* Main split — invisible when dialog is open (keeps layout for workbench sizing) */}
      <div
        style={{
          opacity: showDialog ? 0 : 1,
          pointerEvents: showDialog ? "none" : undefined,
        }}
        className="flex min-h-0 flex-1"
        onMouseMove={(e) => {
          if (!isDragging.current) return;
          const rect = e.currentTarget.getBoundingClientRect();
          setSplitPct(
            Math.max(
              20,
              Math.min(80, ((e.clientX - rect.left) / rect.width) * 100)
            )
          );
        }}
        onMouseUp={() => {
          isDragging.current = false;
        }}
        onMouseLeave={() => {
          isDragging.current = false;
        }}
      >
        {/* VS Code Workbench (file explorer + editor + tabs) */}
        <div
          className="flex flex-col border-r border-zinc-800"
          style={{ width: `${splitPct}%` }}
        >
          <CodeEditor files={files} onFileChange={handleFileChange} />
          {/* AI refine progress */}
          {generating && streamingCode && !showDialog && (
            <div className="flex shrink-0 items-center gap-2 border-t border-purple-900/50 bg-zinc-950 px-4 py-1.5">
              <Loader2 size={10} className="animate-spin text-purple-400" />
              <span className="text-[10px] text-purple-400">
                Refining... ({Math.round(streamingCode.length / 4)} tokens)
              </span>
              <span className="text-[10px] text-zinc-600">
                Code will be applied when complete
              </span>
            </div>
          )}
        </div>

        <div
          className="w-1 shrink-0 cursor-col-resize bg-zinc-800 transition hover:bg-emerald-600"
          onMouseDown={() => {
            isDragging.current = true;
          }}
        />

        {/* Diagram + Warnings */}
        <div className="flex flex-1 flex-col">
          <div className="flex-1 overflow-auto">
            <Diagram
              model={model}
              warnings={warnings}
              onClickElement={handleClickElement}
            />
          </div>
          {warnings.length > 0 && (
            <div className="max-h-32 overflow-y-auto border-t border-zinc-800 bg-zinc-925">
              {warnings.map((w, i) => (
                <div
                  key={i}
                  className={`flex items-center gap-2 px-4 py-1 text-[10px] ${w.severity === "error" ? "text-red-400" : "text-amber-400"}`}
                >
                  <AlertTriangle size={10} />
                  {w.message}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
