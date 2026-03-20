import { AlertTriangle, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeEditor } from "./components/CodeEditor.js";
import { Diagram } from "./components/Diagram.js";
import { HeaderBar } from "./components/HeaderBar.js";
import { InlinePromptBar } from "./components/InlinePromptBar.js";
import { NpmTerminal } from "./components/NpmTerminal.js";
import { ProjectDialog } from "./components/ProjectDialog.js";
import { PROMPT_TEMPLATES } from "./data/prompts.js";
import { projectFiles, SAMPLE_APP } from "./data/sample-app.js";
import { useAiGenerate } from "./hooks/useAiGenerate.js";
import { useClone } from "./hooks/useClone.js";
import { useEditorErrors } from "./hooks/useEditorErrors.js";
import { useLocalFolder } from "./hooks/useLocalFolder.js";
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
import { hasFileSystemAccess } from "./lib/local-folder.js";
import { navigateToCode } from "./lib/navigate-to-code.js";
import { deriveProjectName } from "./lib/strip-fences.js";
import { validate } from "./lib/validate.js";
import { getWorkspaceErrors, triggerResize } from "./lib/vscode-init.js";
import type { FileTab } from "./types/index.js";
import { emptyModel } from "./types/index.js";

export function Builder() {
  const [files, setFiles] = useState<FileTab[]>([]);
  const [promptInput, setPromptInput] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [showGitImport, setShowGitImport] = useState(false);
  const [gitUrl, _setGitUrl] = useState("");
  const gitUrlRef = useRef("");
  const setGitUrl = useCallback((url: string) => {
    gitUrlRef.current = url;
    _setGitUrl(url);
  }, []);
  const [savedImports, setSavedImports] =
    useState<SavedImport[]>(loadSavedImports);
  const [splitPct, setSplitPct] = useState(50);
  const isDragging = useRef(false);
  const splitRafRef = useRef(0);
  const pendingSplitRef = useRef<number | null>(null);

  // Clean up split RAF on unmount
  useEffect(() => {
    return () => {
      if (splitRafRef.current) cancelAnimationFrame(splitRafRef.current);
    };
  }, []);
  const [projectName, setProjectName] = useState("");
  const [showDialog, setShowDialog] = useState(true);
  const [projectSource, setProjectSource] = useState<
    "sample" | "local" | "github" | "ai" | ""
  >("");
  const [showInlinePrompt, setShowInlinePrompt] = useState(false);
  const [editorCollapsed, setEditorCollapsed] = useState(false);

  // NpmTerminal visibility — show when type downloads start
  const [showNpmTerminal, setShowNpmTerminal] = useState(false);
  useEffect(() => {
    const handler = (event: Event) => {
      const { type } = (event as CustomEvent).detail as { type: string };
      if (type === "start") setShowNpmTerminal(true);
    };
    window.addEventListener("npm-type-fetch", handler);
    return () => window.removeEventListener("npm-type-fetch", handler);
  }, []);

  const tsFiles = useMemo(
    () =>
      files.filter((f) => f.path.endsWith(".ts") || f.path.endsWith(".tsx")),
    [files]
  );

  // ── Editor errors hook ──────────────────────────────────────────────
  const { editorErrorCount, setEditorErrorCount } = useEditorErrors(files);

  // ── Clone hook ──────────────────────────────────────────────────────
  const onCloneComplete = useCallback(
    (result: { files: { path: string; content: string }[] }) => {
      setFiles(result.files);
      setShowGitImport(false);
      setShowPrompt(false);
      setShowDialog(false);
      setEditorErrorCount(0);
      const url = gitUrlRef.current.trim();
      if (url) {
        saveImport(url);
        setSavedImports(loadSavedImports());
        setProjectName(repoLabel(url));
        setProjectSource("github");
      }
    },
    [setEditorErrorCount]
  );

  const { clonePending, cloneLog, cloneError, startClone } = useClone({
    onComplete: onCloneComplete,
  });

  // ── Local folder hook ───────────────────────────────────────────────
  const onLocalFolderOpen = useCallback(
    (result: { name: string; files: { path: string; content: string }[] }) => {
      setFiles(result.files);
      setShowDialog(false);
      setProjectName(result.name);
      setProjectSource("local");
      setEditorErrorCount(0);
    },
    [setEditorErrorCount]
  );

  const {
    localLoading,
    localError,
    savedFolders,
    handleLocalFolder: handleLocalFolderRaw,
    handleReopenFolder,
    removeSavedFolderAndUpdate,
  } = useLocalFolder({ onOpen: onLocalFolderOpen });

  const handleLocalFolder = useCallback(async () => {
    setFiles([]);
    setEditorErrorCount(0);
    await handleLocalFolderRaw();
  }, [handleLocalFolderRaw, setEditorErrorCount]);

  const handleReopenFolderWrapped = useCallback(
    async (saved: Parameters<typeof handleReopenFolder>[0]) => {
      setFiles([]);
      setEditorErrorCount(0);
      await handleReopenFolder(saved);
    },
    [handleReopenFolder, setEditorErrorCount]
  );

  // ── AI generate hook ────────────────────────────────────────────────
  const aiContext = useCallback(
    () => ({ promptInput, files, tsFiles, showDialog }),
    [promptInput, files, tsFiles, showDialog]
  );

  const aiCallbacks = useMemo(
    () => ({
      onFreshStart: (trimmed: string) => {
        setFiles([
          { path: "src/app.ts", content: "" },
          ...projectFiles(projectName),
        ]);
        setShowPrompt(false);
        setShowDialog(false);
        setProjectName(deriveProjectName(trimmed));
        setProjectSource("ai");
      },
      onCodeStreaming: (code: string) => {
        setFiles((prev) => {
          const idx = prev.findIndex((f) => f.path.endsWith(".ts"));
          if (idx < 0) return [{ path: "src/app.ts", content: code }, ...prev];
          return prev.map((f, i) => (i === idx ? { ...f, content: code } : f));
        });
      },
      onComplete: (finalCode: string, isRefine: boolean) => {
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
        if (!isRefine) {
          setProjectName((prev) => deriveProjectName(prev, finalCode));
        }
      },
      onClearPrompt: () => {
        setPromptInput("");
      },
    }),
    [projectName]
  );

  const {
    generating,
    generateError,
    streamingCode,
    tokenUsage,
    setAiModel,
    setAiMaxTokens,
    effectiveModel,
    effectiveMaxTokens,
    handleGenerate,
    config,
  } = useAiGenerate(aiContext, aiCallbacks);

  // ── Model extraction and validation (debounced to avoid blocking UI) ──
  const [model, setModel] = useState(emptyModel());
  const [evalError, setEvalError] = useState<string | undefined>();
  useEffect(() => {
    if (tsFiles.length === 0) {
      setModel(emptyModel());
      setEvalError(undefined);
      return;
    }
    // Defer extraction to avoid blocking the initial render
    const timer = setTimeout(() => {
      try {
        const { model: m, error } = extractModel(tsFiles);
        if (error) {
          setEvalError(error);
        } else {
          setModel(m);
          setEvalError(undefined);
        }
      } catch (e) {
        setEvalError(e instanceof Error ? e.message : String(e));
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [tsFiles]);

  const warnings = useMemo(() => {
    const w = validate(model);
    if (evalError) {
      w.unshift({ message: evalError, severity: "error" as const });
    }
    return w;
  }, [model, evalError]);

  // ── Git fetch handler ───────────────────────────────────────────────
  const handleGitFetch = useCallback(() => {
    const parsed = parseGitUrl(gitUrl.trim());
    if (!parsed) return;
    setFiles([]);
    setEditorErrorCount(0);
    startClone({ ...parsed, entryPath: parsed.entryPath });
  }, [gitUrl, startClone, setEditorErrorCount]);

  // ── File change handler ─────────────────────────────────────────────
  const handleFileChange = useCallback((index: number, content: string) => {
    setFiles((prev) =>
      prev.map((f, i) => (i === index ? { ...f, content } : f))
    );
  }, []);

  // ── Click element in diagram -> navigate to code ─────────────────────
  const handleClickElement = useCallback(
    (name: string, type?: string) => navigateToCode(files, name, type),
    [files]
  );

  // ── Sample app loader ───────────────────────────────────────────────
  const loadSampleApp = useCallback(() => {
    setFiles(SAMPLE_APP);
    setProjectName("Todo App");
    setProjectSource("sample");
    setShowGitImport(false);
    setShowPrompt(false);
    setShowDialog(false);
  }, []);

  // ── Clear project ───────────────────────────────────────────────────
  const clearProject = useCallback(() => {
    setFiles([]);
    setProjectName("");
    setProjectSource("");
    setGitUrl("");
    setShowGitImport(false);
    setShowPrompt(false);
    setShowDialog(true);
    setPromptInput("");
    setShowInlinePrompt(false);
    setEditorErrorCount(0);
  }, [setEditorErrorCount]);

  // ── Append errors to prompt ─────────────────────────────────────────
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

  const aiModels = config?.models ?? [
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  ];

  const handleCloneSavedImport = useCallback(
    (s: SavedImport) => {
      setGitUrl(s.url);
      const parsed = parseGitUrl(s.url);
      if (parsed) startClone({ ...parsed, entryPath: parsed.entryPath });
    },
    [startClone]
  );

  const handleRemoveSavedImport = useCallback(
    (url: string) => setSavedImports(removeSavedImport(url)),
    []
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <HeaderBar
        projectName={projectName}
        projectSource={projectSource}
        clearProject={clearProject}
        showNpmTerminal={showNpmTerminal}
        onShowNpmTerminal={() => setShowNpmTerminal(true)}
        generating={generating}
        streamingCode={streamingCode}
        tokenUsage={tokenUsage}
        generateError={generateError}
        warnings={warnings}
        filesExist={files.length > 0}
        showInlinePrompt={showInlinePrompt}
        onToggleInlinePrompt={() => setShowInlinePrompt((v) => !v)}
        editorErrorCount={editorErrorCount}
        appendErrors={appendErrors}
        onDownload={() => downloadProject(files, projectName)}
      />

      {showDialog && (
        <ProjectDialog
          showGitImport={showGitImport}
          showPrompt={showPrompt}
          onShowGitImport={setShowGitImport}
          onShowPrompt={setShowPrompt}
          clonePending={clonePending}
          localLoading={localLoading}
          cloneLog={cloneLog}
          onLoadSample={loadSampleApp}
          canOpenLocal={canOpenLocal}
          onOpenLocal={handleLocalFolder}
          localError={localError}
          savedFolders={savedFolders}
          onReopenFolder={handleReopenFolderWrapped}
          onRemoveSavedFolder={removeSavedFolderAndUpdate}
          gitUrl={gitUrl}
          onGitUrlChange={setGitUrl}
          onGitFetch={handleGitFetch}
          cloneError={cloneError}
          savedImports={savedImports}
          onCloneSavedImport={handleCloneSavedImport}
          onRemoveSavedImport={handleRemoveSavedImport}
          promptInput={promptInput}
          onPromptInputChange={setPromptInput}
          onGenerate={handleGenerate}
          generating={generating}
          generateError={generateError}
          promptTemplates={PROMPT_TEMPLATES}
          effectiveModel={effectiveModel}
          onModelChange={setAiModel}
          effectiveMaxTokens={effectiveMaxTokens}
          onMaxTokensChange={setAiMaxTokens}
          models={aiModels}
        />
      )}

      {showInlinePrompt && files.length > 0 && (
        <InlinePromptBar
          promptInput={promptInput}
          onPromptInputChange={setPromptInput}
          onGenerate={handleGenerate}
          onClose={() => setShowInlinePrompt(false)}
          generating={generating}
          effectiveModel={effectiveModel}
          onModelChange={setAiModel}
          models={aiModels}
        />
      )}

      <NpmTerminal
        show={showNpmTerminal}
        onClose={() => setShowNpmTerminal(false)}
        projectKey={projectName}
      />

      {/* Main split */}
      <div
        style={{
          opacity: showDialog ? 0 : 1,
          pointerEvents: showDialog ? "none" : undefined,
        }}
        className="flex min-h-0 flex-1"
        onMouseMove={(e) => {
          if (!isDragging.current) return;
          const rect = e.currentTarget.getBoundingClientRect();
          pendingSplitRef.current = Math.max(
            20,
            Math.min(80, ((e.clientX - rect.left) / rect.width) * 100)
          );
          if (!splitRafRef.current) {
            splitRafRef.current = requestAnimationFrame(() => {
              splitRafRef.current = 0;
              if (pendingSplitRef.current !== null) {
                setSplitPct(pendingSplitRef.current);
                pendingSplitRef.current = null;
              }
            });
          }
        }}
        onMouseUp={() => {
          isDragging.current = false;
          triggerResize();
        }}
        onMouseLeave={() => {
          isDragging.current = false;
          triggerResize();
        }}
      >
        <div
          className="flex flex-col border-r border-zinc-800"
          style={{
            width: editorCollapsed ? 0 : `${splitPct}%`,
            overflow: "hidden",
          }}
        >
          <CodeEditor files={files} onFileChange={handleFileChange} />
          {generating && streamingCode && !showDialog && !editorCollapsed && (
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

        {!editorCollapsed && (
          <div
            className="w-1 shrink-0 cursor-col-resize bg-zinc-800 transition hover:bg-emerald-600"
            onMouseDown={() => {
              isDragging.current = true;
            }}
          />
        )}

        <div className="flex flex-1 flex-col">
          <div className="flex-1 overflow-auto">
            <Diagram
              model={model}
              warnings={warnings}
              onClickElement={handleClickElement}
              editorCollapsed={editorCollapsed}
              onToggleEditor={() => {
                setEditorCollapsed((v) => !v);
                setTimeout(triggerResize, 50);
              }}
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
