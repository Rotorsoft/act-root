import { Editor as MonacoEditor } from "@monaco-editor/react";
import {
  AlertTriangle,
  Clipboard,
  Download,
  Loader2,
  Send,
  Sparkles,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Diagram } from "../builder/Diagram.js";
import { parseActCode } from "../builder/parser.js";
import { templates } from "../builder/templates.js";
import { emptyModel } from "../builder/types.js";
import { validate } from "../builder/validate.js";
import { trpc } from "../trpc.js";

const PROMPT_TEMPLATES = [
  {
    label: "E-commerce orders",
    prompt:
      "Build an e-commerce order management system with order creation, payment processing, shipping, and delivery tracking. Include invariants for valid state transitions.",
  },
  {
    label: "Content moderation",
    prompt:
      "Build a content moderation pipeline where users submit content, moderators review it, and content can be approved, rejected, or escalated. Track moderator statistics.",
  },
  {
    label: "IoT fleet",
    prompt:
      "Build an IoT device fleet management system with device registration, telemetry ingestion, alert thresholds, and maintenance scheduling.",
  },
];

export function Builder() {
  const [code, setCode] = useState(templates[0].code);
  const [promptInput, setPromptInput] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const editorRef = useRef<any>(null);

  const generateMutation = trpc.generate.useMutation({
    onSuccess: (result) => {
      setCode(result.code);
      setShowPrompt(false);
    },
  });

  // Parse and validate
  const model = useMemo(() => {
    try {
      return parseActCode(code);
    } catch {
      return emptyModel();
    }
  }, [code]);

  const warnings = useMemo(() => validate(model), [model]);

  const handleGenerate = useCallback(() => {
    const trimmed = promptInput.trim();
    if (!trimmed) return;
    generateMutation.mutate({ prompt: trimmed, currentCode: code });
  }, [promptInput, code, generateMutation]);

  const handleEditorMount = useCallback((editor: any) => {
    editorRef.current = editor;
  }, []);

  const handleClickLine = useCallback((line: number) => {
    const editor = editorRef.current;
    if (editor) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
      editor.focus();
    }
  }, []);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(code);
  }, [code]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([code], { type: "text/typescript" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "act-app.ts";
    a.click();
    URL.revokeObjectURL(url);
  }, [code]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-925 px-4 py-1.5">
        {/* Templates */}
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          Template
        </span>
        {templates.map((t) => (
          <button
            key={t.name}
            onClick={() => setCode(t.code)}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-[10px] text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-300"
            title={t.description}
          >
            {t.name}
          </button>
        ))}

        <div className="mx-2 h-4 w-px bg-zinc-800" />

        {/* AI generate */}
        <button
          onClick={() => setShowPrompt(!showPrompt)}
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
          {/* Warnings */}
          {warnings.length > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-amber-400">
              <AlertTriangle size={11} />
              {warnings.length}
            </span>
          )}

          {/* Export */}
          <button
            onClick={handleCopy}
            className="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
            title="Copy code"
          >
            <Clipboard size={13} />
          </button>
          <button
            onClick={handleDownload}
            className="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
            title="Download as .ts"
          >
            <Download size={13} />
          </button>
        </div>
      </div>

      {/* AI prompt bar */}
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
              placeholder="Describe your domain... (Enter to generate, Shift+Enter for newline)"
              rows={2}
              className="min-h-0 flex-1 resize-none rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 outline-none transition placeholder:text-zinc-600 focus:border-purple-600"
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

      {/* Main split: Editor | Diagram */}
      <div className="flex min-h-0 flex-1">
        {/* Code editor */}
        <div className="flex w-1/2 flex-col border-r border-zinc-800">
          <MonacoEditor
            height="100%"
            language="typescript"
            theme="vs-dark"
            value={code}
            onChange={(v: string | undefined) => setCode(v ?? "")}
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
            }}
          />
        </div>

        {/* Diagram + Warnings */}
        <div className="flex w-1/2 flex-col">
          <div className="flex-1 overflow-auto">
            <Diagram
              model={model}
              warnings={warnings}
              onClickLine={handleClickLine}
            />
          </div>

          {/* Warnings panel */}
          {warnings.length > 0 && (
            <div className="max-h-32 overflow-y-auto border-t border-zinc-800 bg-zinc-925">
              {warnings.map((w, i) => (
                <div
                  key={i}
                  className={`flex items-center gap-2 px-4 py-1 text-[10px] ${
                    w.severity === "error" ? "text-red-400" : "text-amber-400"
                  }`}
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
