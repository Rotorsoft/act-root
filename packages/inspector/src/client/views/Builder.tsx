import { Editor as MonacoEditor } from "@monaco-editor/react";
import {
  AlertTriangle,
  Clipboard,
  Download,
  Loader2,
  Plus,
  Send,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Diagram } from "../builder/Diagram.js";
import { parseActCode } from "../builder/parser.js";
import { emptyModel } from "../builder/types.js";
import { validate } from "../builder/validate.js";
import { trpc } from "../trpc.js";

type FileTab = { path: string; content: string };

/** Parse GitHub URL → owner/repo/branch/path */
function parseGitUrl(url: string): {
  owner: string;
  repo: string;
  branch: string;
  entryPath: string;
} | null {
  const m = url.match(
    /github\.com\/([^/]+)\/([^/]+)\/(?:blob|tree)\/([^/]+)\/(.+)/
  );
  if (m) return { owner: m[1], repo: m[2], branch: m[3], entryPath: m[4] };
  return null;
}

const SNIPPETS: Record<string, string> = {
  State: `import { state, type Invariant } from "@rotorsoft/act";
import { z } from "zod";

// --- Invariant (business rule) ---
const mustBeActive: Invariant<{ status: string }> = {
  description: "Must be active",
  valid: (state) => state.status === "active",
};

// --- State ---
const MyEntity = state({ MyEntity: z.object({
  name: z.string(),
  status: z.string(),
})})
  .init(() => ({ name: "", status: "active" }))
  .emits({
    EntityCreated: z.object({ name: z.string() }),
    EntityUpdated: z.object({ name: z.string() }),
  })
  .patch({
    EntityCreated: ({ data }) => ({ name: data.name, status: "active" }),
    EntityUpdated: ({ data }) => ({ name: data.name }),
  })
  .on({ CreateEntity: z.object({ name: z.string() }) })
    .emit("EntityCreated")
  .on({ UpdateEntity: z.object({ name: z.string() }) })
    .given([mustBeActive])
    .emit("EntityUpdated")
  .build();

export { MyEntity };
`,
  Slice: `import { slice } from "@rotorsoft/act";
import { MyEntity } from "./state.js";

// --- Slice (vertical feature grouping) ---
const MySlice = slice()
  .withState(MyEntity)
  // .withProjection(MyProjection)
  .on("EntityCreated")
    .do(async function onEntityCreated(event, _stream, app) {
      // Dispatch another action in response
      // await app.do("OtherAction", { stream: target, actor: { id: "system", name: "System" } }, payload, event);
      console.log("Entity created:", event.stream);
    })
    .to((event) => ({ target: event.stream }))
  .build();

export { MySlice };
`,
  Projection: `import { projection } from "@rotorsoft/act";
import { z } from "zod";

// --- Projection (read model) ---
const MyProjection = projection("my-view")
  .on({ EntityCreated: z.object({ name: z.string() }) })
    .do(async ({ stream, data }) => {
      // Update read model (database, cache, etc.)
      console.log("Projecting EntityCreated:", stream, data.name);
    })
  .build();

export { MyProjection };
`,
  Act: `import { act } from "@rotorsoft/act";
import { MySlice } from "./slice.js";
import { MyProjection } from "./projection.js";

// --- Orchestrator (wires everything together) ---
const app = act()
  // .withActor<AppActor>()
  .withSlice(MySlice)
  .withProjection(MyProjection)
  .build();

export { app };
`,
  All: `import { act, state, slice, projection, type Invariant } from "@rotorsoft/act";
import { z } from "zod";

// ============================================================
// Invariants
// ============================================================

const mustBeActive: Invariant<{ status: string }> = {
  description: "Must be active",
  valid: (state) => state.status === "active",
};

// ============================================================
// State
// ============================================================

const MyEntity = state({ MyEntity: z.object({
  name: z.string(),
  status: z.string(),
})})
  .init(() => ({ name: "", status: "active" }))
  .emits({
    EntityCreated: z.object({ name: z.string() }),
    EntityUpdated: z.object({ name: z.string() }),
    EntityDeactivated: z.object({ deactivatedBy: z.string() }),
  })
  .patch({
    EntityCreated: ({ data }) => ({ name: data.name, status: "active" }),
    EntityUpdated: ({ data }) => ({ name: data.name }),
    EntityDeactivated: () => ({ status: "inactive" }),
  })
  .on({ CreateEntity: z.object({ name: z.string() }) })
    .emit("EntityCreated")
  .on({ UpdateEntity: z.object({ name: z.string() }) })
    .given([mustBeActive])
    .emit("EntityUpdated")
  .on({ DeactivateEntity: z.object({}) })
    .given([mustBeActive])
    .emit((_, __, { actor }) => ["EntityDeactivated", { deactivatedBy: actor.id }])
  .build();

// ============================================================
// Projection
// ============================================================

const MyProjection = projection("my-view")
  .on({ EntityCreated: z.object({ name: z.string() }) })
    .do(async ({ stream, data }) => {
      console.log("Created:", stream, data.name);
    })
  .on({ EntityDeactivated: z.object({ deactivatedBy: z.string() }) })
    .do(async ({ stream }) => {
      console.log("Deactivated:", stream);
    })
  .build();

// ============================================================
// Slice
// ============================================================

const MySlice = slice()
  .withState(MyEntity)
  .withProjection(MyProjection)
  .on("EntityCreated")
    .do(async function onCreated(event, _stream, app) {
      console.log("Reacting to creation:", event.stream);
      // await app.do("OtherAction", target, payload, event);
    })
    .to((event) => ({ target: event.stream }))
  .build();

// ============================================================
// Orchestrator
// ============================================================

const app = act()
  .withSlice(MySlice)
  .withProjection(MyProjection)
  .build();

export { app, MyEntity, MySlice, MyProjection };
`,
};

const PROMPT_TEMPLATES = [
  {
    label: "E-commerce",
    prompt:
      "Build an e-commerce order management system with order creation, payment processing, shipping, and delivery tracking. Include invariants for valid state transitions.",
  },
  {
    label: "Content moderation",
    prompt:
      "Build a content moderation pipeline where users submit content, moderators review it, and content can be approved, rejected, or escalated.",
  },
  {
    label: "IoT fleet",
    prompt:
      "Build an IoT device fleet management system with device registration, telemetry ingestion, alert thresholds, and maintenance scheduling.",
  },
];

type SavedImport = { url: string; label: string };

function loadSavedImports(): SavedImport[] {
  try {
    const raw = localStorage.getItem("inspector:git-imports");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveImport(url: string) {
  const saved = loadSavedImports();
  // e.g. "owner/repo/.../file.ts" → "repo/path/to/file"
  const parts = url.replace(/https?:\/\/github\.com\//, "").split("/");
  const label =
    parts.length > 4
      ? parts
          .slice(1)
          .filter((p) => p !== "blob" && p !== "tree")
          .join("/")
          .replace(/\.ts$/, "")
      : parts.slice(-2).join("/").replace(/\.ts$/, "");
  if (saved.some((s) => s.url === url)) return;
  const updated = [{ url, label }, ...saved].slice(0, 10);
  localStorage.setItem("inspector:git-imports", JSON.stringify(updated));
}

// GitHub SVG icon (lucide's Github is deprecated)
function GithubIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

export function Builder() {
  const [files, setFiles] = useState<FileTab[]>([]);
  const [activeFile, setActiveFile] = useState(0);
  const [promptInput, setPromptInput] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [showGitImport, setShowGitImport] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [savedImports, setSavedImports] =
    useState<SavedImport[]>(loadSavedImports);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<any>(null);
  const [splitPct, setSplitPct] = useState(50);
  const isDragging = useRef(false);

  const code = files.length > 0 ? (files[activeFile]?.content ?? "") : "";
  const allCode = files.map((f) => f.content).join("\n\n");

  const generateMutation = trpc.generate.useMutation({
    onSuccess: (result) => {
      setFiles([{ path: "generated.ts", content: result.code }]);
      setActiveFile(0);
      setShowPrompt(false);
    },
  });

  const fetchMutation = trpc.fetchFromGit.useMutation({
    onSuccess: (result) => {
      setFiles(result.files);
      setActiveFile(0);
      setShowGitImport(false);
      if (gitUrl.trim()) {
        saveImport(gitUrl.trim());
        setSavedImports(loadSavedImports());
      }
    },
  });

  const model = useMemo(() => {
    try {
      return parseActCode(allCode);
    } catch {
      return emptyModel();
    }
  }, [allCode]);

  const warnings = useMemo(() => validate(model), [model]);

  const handleGitFetch = useCallback(() => {
    const parsed = parseGitUrl(gitUrl.trim());
    if (!parsed || !parsed.entryPath) return;
    fetchMutation.mutate(parsed);
  }, [gitUrl, fetchMutation]);

  const handleGenerate = useCallback(() => {
    const trimmed = promptInput.trim();
    if (!trimmed) return;
    generateMutation.mutate({
      prompt: trimmed,
      currentCode: allCode || undefined,
    });
  }, [promptInput, allCode, generateMutation]);

  const handleEditorMount = useCallback((editor: any, monaco: any) => {
    editorRef.current = editor;

    // Configure TypeScript to handle .js imports as .ts
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2022,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      allowJs: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
      allowImportingTsExtensions: true,
    });

    // Suppress "cannot find module" for framework imports
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
      diagnosticCodesToIgnore: [2307, 2792, 7016], // Cannot find module, moduleResolution, implicit any
    });

    // Add minimal type stubs for @rotorsoft/act
    monaco.languages.typescript.typescriptDefaults.addExtraLib(
      `declare module "@rotorsoft/act" {
  export function state<T>(schema: Record<string, any>): any;
  export function slice(): any;
  export function projection(name?: string): any;
  export function act(): any;
  export function store(adapter?: any): any;
  export const ZodEmpty: any;
  export type Invariant<S, A = any> = { description: string; valid: (state: Readonly<S>, actor?: A) => boolean };
  export type Actor = { id: string; name: string };
  export type Target = { stream: string; actor: Actor };
  export type Committed<E, K> = { id: number; name: K; data: E[K & keyof E]; stream: string; version: number; created: Date; meta: any };
  export type InferEvents<T> = any;
  export type InferActions<T> = any;
  export function dispose(d?: any): any;
}`,
      "file:///node_modules/@rotorsoft/act/index.d.ts"
    );

    monaco.languages.typescript.typescriptDefaults.addExtraLib(
      `declare module "@rotorsoft/act-patch" {
  export type Patch<T> = Partial<T>;
}`,
      "file:///node_modules/@rotorsoft/act-patch/index.d.ts"
    );

    monaco.languages.typescript.typescriptDefaults.addExtraLib(
      `declare module "zod" {
  export function object(shape: any): any;
  export function string(): any;
  export function number(): any;
  export function boolean(): any;
  export function array(inner: any): any;
  export function enum_(values: readonly string[]): any;
  export { enum_ as enum };
  export function uuid(): any;
  export function optional(): any;
  export const z: {
    object: typeof object;
    string: typeof string;
    number: typeof number;
    boolean: typeof boolean;
    array: typeof array;
    enum: typeof enum_;
    uuid: typeof uuid;
  };
  export { z };
}`,
      "file:///node_modules/zod/index.d.ts"
    );
  }, []);

  const handleClickLine = useCallback((line: number) => {
    const editor = editorRef.current;
    if (editor) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
      editor.focus();
    }
  }, []);

  const handleFileChange = useCallback(
    (value: string | undefined) => {
      setFiles((prev) =>
        prev.map((f, i) =>
          i === activeFile ? { ...f, content: value ?? "" } : f
        )
      );
    },
    [activeFile]
  );

  // Close "New" dropdown on outside click
  useEffect(() => {
    if (!showNewMenu) return;
    const handler = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node))
        setShowNewMenu(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showNewMenu]);

  const insertSnippet = useCallback((key: string) => {
    const snippet = SNIPPETS[key];
    if (!snippet) return;

    // Determine files to add: main snippet + dependencies
    const deps: Record<string, FileTab[]> = {
      State: [{ path: "state.ts", content: SNIPPETS.State }],
      Projection: [{ path: "projection.ts", content: SNIPPETS.Projection }],
      Slice: [
        { path: "state.ts", content: SNIPPETS.State },
        { path: "slice.ts", content: SNIPPETS.Slice },
      ],
      Act: [
        { path: "state.ts", content: SNIPPETS.State },
        { path: "projection.ts", content: SNIPPETS.Projection },
        { path: "slice.ts", content: SNIPPETS.Slice },
        { path: "act.ts", content: SNIPPETS.Act },
      ],
      All: [{ path: "app.ts", content: SNIPPETS.All }],
    };

    const toAdd = deps[key] ?? [
      { path: `${key.toLowerCase()}.ts`, content: snippet },
    ];
    setFiles((prev) => {
      const result = [...prev];
      let lastIdx = result.length;
      for (const file of toAdd) {
        const idx = result.findIndex((f) => f.path === file.path);
        if (idx >= 0) {
          result[idx] = file;
          lastIdx = idx;
        } else {
          lastIdx = result.length;
          result.push(file);
        }
      }
      // Focus the last added/updated file
      setActiveFile(lastIdx);
      return result;
    });
    setShowNewMenu(false);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-925 px-4 py-1.5">
        {/* New snippet dropdown */}
        <div className="relative" ref={newMenuRef}>
          <button
            onClick={() => setShowNewMenu(!showNewMenu)}
            className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] transition ${
              showNewMenu
                ? "border-blue-600 bg-blue-950 text-blue-400"
                : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-blue-700 hover:text-blue-400"
            }`}
          >
            <Plus size={11} />
            New
          </button>
          {showNewMenu && (
            <div className="absolute left-0 top-full z-50 mt-1 min-w-[140px] rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl">
              {Object.keys(SNIPPETS).map((key) => (
                <button
                  key={key}
                  onClick={() => insertSnippet(key)}
                  className="flex w-full items-center px-3 py-1.5 text-left text-[10px] text-zinc-300 transition hover:bg-zinc-800 hover:text-white"
                >
                  {key === "All" ? "Full App (all)" : key}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={() => {
            setShowGitImport(!showGitImport);
            setShowPrompt(false);
          }}
          className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] transition ${
            showGitImport
              ? "border-emerald-600 bg-emerald-950 text-emerald-400"
              : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-emerald-700 hover:text-emerald-400"
          }`}
        >
          <GithubIcon size={11} />
          Import
        </button>

        <button
          onClick={() => {
            setShowPrompt(!showPrompt);
            setShowGitImport(false);
          }}
          className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] transition ${
            showPrompt
              ? "border-purple-600 bg-purple-950 text-purple-400"
              : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-purple-700 hover:text-purple-400"
          }`}
        >
          <Sparkles size={11} />
          AI Generate
        </button>

        <div className="ml-auto flex items-center gap-2">
          {warnings.length > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-amber-400">
              <AlertTriangle size={11} />
              {warnings.length}
            </span>
          )}
          <button
            onClick={() => void navigator.clipboard.writeText(allCode)}
            className="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
            title="Copy all code"
          >
            <Clipboard size={13} />
          </button>
          <button
            onClick={() => {
              const blob = new Blob([allCode], { type: "text/typescript" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "act-app.ts";
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
            title="Download"
          >
            <Download size={13} />
          </button>
        </div>
      </div>

      {/* GitHub import panel */}
      {showGitImport && (
        <div className="border-b border-zinc-800 bg-emerald-950/20 px-4 py-2">
          {savedImports.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {savedImports.map((s) => (
                <div key={s.url} className="flex items-center gap-0.5">
                  <button
                    onClick={() => {
                      setGitUrl(s.url);
                      const parsed = parseGitUrl(s.url);
                      if (parsed?.entryPath) fetchMutation.mutate(parsed);
                    }}
                    className="truncate rounded-md border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[9px] text-zinc-400 transition hover:border-emerald-700 hover:text-emerald-400"
                    title={s.url}
                  >
                    {s.label}
                  </button>
                  <button
                    onClick={() => {
                      const updated = loadSavedImports().filter(
                        (x) => x.url !== s.url
                      );
                      localStorage.setItem(
                        "inspector:git-imports",
                        JSON.stringify(updated)
                      );
                      setSavedImports(updated);
                    }}
                    className="text-[9px] text-zinc-600 transition hover:text-red-400"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <GithubIcon size={14} />
            <input
              type="text"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleGitFetch()}
              placeholder="https://github.com/owner/repo/blob/branch/path/to/file.ts"
              className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-600"
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
              Fetch
            </button>
          </div>
          {fetchMutation.error && (
            <div className="mt-1.5 text-[10px] text-red-400">
              {fetchMutation.error.message}
            </div>
          )}
        </div>
      )}

      {/* AI prompt panel */}
      {showPrompt && (
        <div className="border-b border-zinc-800 bg-purple-950/20 px-4 py-2">
          <div className="mb-2 flex gap-1.5">
            {PROMPT_TEMPLATES.map((pt) => (
              <button
                key={pt.label}
                onClick={() => setPromptInput(pt.prompt)}
                className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[9px] text-zinc-400 transition hover:border-purple-700 hover:text-purple-400"
              >
                {pt.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <textarea
              value={promptInput}
              onChange={(e) => setPromptInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleGenerate();
                }
              }}
              placeholder="Describe your domain..."
              rows={2}
              className="min-h-0 flex-1 resize-none rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-purple-600"
            />
            <button
              onClick={handleGenerate}
              disabled={generateMutation.isPending || !promptInput.trim()}
              className="flex shrink-0 items-center gap-1 self-end rounded-md bg-purple-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-purple-500 disabled:opacity-50"
            >
              {generateMutation.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Send size={12} />
              )}
              Generate
            </button>
          </div>
          {generateMutation.error && (
            <div className="mt-1.5 text-[10px] text-red-400">
              {generateMutation.error.message}
            </div>
          )}
        </div>
      )}

      {/* Main split */}
      <div
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
        {/* Editor with file tabs */}
        <div
          className="flex flex-col border-r border-zinc-800"
          style={{ width: `${splitPct}%` }}
        >
          {/* File tabs */}
          {files.length > 0 && (
            <div className="flex shrink-0 overflow-x-auto border-b border-zinc-700 bg-zinc-800">
              {files.map((f, i) => {
                const name = f.path.split("/").pop() ?? f.path;
                return (
                  <button
                    key={f.path}
                    onClick={() => setActiveFile(i)}
                    className={`shrink-0 border-r border-zinc-700 px-3 py-1.5 text-[11px] transition ${
                      i === activeFile
                        ? "bg-zinc-900 text-emerald-400"
                        : "bg-zinc-800 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                    }`}
                    title={f.path}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          )}
          <div className="min-h-0 flex-1">
            <MonacoEditor
              height="100%"
              language="typescript"
              theme="vs-dark"
              value={code}
              onChange={handleFileChange}
              onMount={handleEditorMount}
              options={{
                fontSize: 12,
                fontFamily: "'JetBrains Mono', monospace",
                minimap: { enabled: false },
                lineNumbers: "on",
                scrollBeyondLastLine: false,
                wordWrap: "on",
                tabSize: 2,
                padding: { top: 8 },
                renderLineHighlight: "line",
                occurrencesHighlight: "off",
                readOnly: false,
              }}
            />
          </div>
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
              onClickLine={handleClickLine}
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
