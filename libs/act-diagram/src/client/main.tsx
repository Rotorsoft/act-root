import { FolderOpen, RefreshCw, Save, Undo2 } from "lucide-react";
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ActDiagram } from "./components/ActDiagram.js";
import { CodePreview } from "./components/CodePreview.js";
import { parseMultiFileResponse } from "./lib/strip-fences.js";
import "./styles.css";
import type { FileTab } from "./types/file-tab.js";

const AI_URL = "http://localhost:4002/api/generate";

async function readDirectory(
  dirHandle: FileSystemDirectoryHandle,
  prefix = ""
): Promise<FileTab[]> {
  const files: FileTab[] = [];
  for await (const entry of dirHandle.values()) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (
      entry.kind === "file" &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      const file = await (entry as FileSystemFileHandle).getFile();
      const content = await file.text();
      files.push({ path, content });
    } else if (
      entry.kind === "directory" &&
      !["node_modules", "dist", ".git", "coverage"].includes(entry.name)
    ) {
      const nested = await readDirectory(
        entry as FileSystemDirectoryHandle,
        path
      );
      files.push(...nested);
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Write files to a directory, creating subdirectories as needed */
async function writeFiles(
  dirHandle: FileSystemDirectoryHandle,
  files: FileTab[]
) {
  for (const file of files) {
    const parts = file.path.split("/");
    let dir = dirHandle;
    // Create nested directories
    for (const part of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part, { create: true });
    }
    const name = parts[parts.length - 1];
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(file.content);
    await writable.close();
  }
}

function DevApp() {
  const [files, setFiles] = useState<FileTab[]>([]);
  const [folderName, setFolderName] = useState<string>("");
  const [preview, setPreview] = useState<{
    file: string;
    line: number;
    col: number;
    type?: string;
  } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [aiStream, setAiStream] = useState("");
  const aiStreamRef = useRef<HTMLPreElement>(null);
  const [unsaved, setUnsaved] = useState(false);
  const dirRef = useRef<FileSystemDirectoryHandle | null>(null);

  const openFolder = useCallback(async () => {
    try {
      const handle = await showDirectoryPicker();
      dirRef.current = handle;
      setFolderName(handle.name);
      setUnsaved(false);
      const scanned = await readDirectory(handle);
      setFiles(scanned);
    } catch {
      // user cancelled
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!dirRef.current) return;
    const scanned = await readDirectory(dirRef.current);
    setFiles((prev) => {
      if (prev.length !== scanned.length) return scanned;
      for (let i = 0; i < prev.length; i++) {
        if (
          prev[i].path !== scanned[i].path ||
          prev[i].content !== scanned[i].content
        )
          return scanned;
      }
      return prev;
    });
  }, []);

  // Auto-scroll AI stream to bottom
  useEffect(() => {
    if (aiStreamRef.current) {
      aiStreamRef.current.scrollTop = aiStreamRef.current.scrollHeight;
    }
  }, [aiStream]);

  // Poll for changes every 2s — paused while unsaved AI changes are pending
  useEffect(() => {
    if (!dirRef.current || unsaved) return;
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
  }, [folderName, refresh, unsaved]);

  const handleAiRequest = useCallback(
    async (prompt: string, currentFiles: FileTab[]) => {
      setGenerating(true);
      setAiStream("");
      try {
        const res = await fetch(AI_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            currentFiles,
            refine: currentFiles.length > 0,
          }),
        });
        if (!res.ok) throw new Error(await res.text());

        const reader = res.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = "";
        let fullText = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Parse SSE lines
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.type === "text") {
                fullText += evt.text;
                setAiStream(fullText);
              }
              if (evt.type === "error") console.error("AI error:", evt.message);
            } catch {
              // ignore malformed lines
            }
          }
        }

        const newFiles = parseMultiFileResponse(fullText);
        if (newFiles.length > 0) {
          setFiles(newFiles);
          setPreview(null);
          setUnsaved(true);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setAiStream(
          msg.includes("Failed to fetch")
            ? "Cannot connect to AI server.\n\nStart it with:\n  ANTHROPIC_API_KEY=sk-ant-... pnpm -F @rotorsoft/act-diagram dev:server"
            : `Error: ${msg}`
        );
        // Keep the error visible for a moment before clearing
        await new Promise((r) => setTimeout(r, 5000));
      } finally {
        setGenerating(false);
        setAiStream("");
      }
    },
    []
  );

  const saveFiles = useCallback(async () => {
    try {
      let dir = dirRef.current;
      if (!dir) {
        // No folder open — pick one to save into
        dir = await showDirectoryPicker();
        dirRef.current = dir;
        setFolderName(dir.name);
      }
      await writeFiles(dir, files);
      setUnsaved(false);
    } catch {
      // user cancelled or write failed
    }
  }, [files]);

  const discardChanges = useCallback(async () => {
    if (!dirRef.current) {
      // No folder — just clear everything
      setFiles([]);
      setUnsaved(false);
      setPreview(null);
      return;
    }
    // Reload from disk
    const scanned = await readDirectory(dirRef.current);
    setFiles(scanned);
    setUnsaved(false);
    setPreview(null);
  }, []);

  // Clear preview if the file was deleted
  useEffect(() => {
    if (preview && !files.some((f) => f.path === preview.file)) {
      setPreview(null);
    }
  }, [files, preview]);

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-4 py-2">
        <span className="text-xs font-semibold text-zinc-300">Act Diagram</span>
        <button
          onClick={() => void openFolder()}
          className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-[11px] text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-700"
        >
          <FolderOpen size={12} />
          Open Act Project
        </button>
        {folderName && (
          <>
            <span className="text-[10px] text-zinc-500">{folderName}</span>
            <span className="text-[10px] text-zinc-600">
              {files.length} files
            </span>
            <button
              onClick={() => void refresh()}
              className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
              title="Refresh"
            >
              <RefreshCw size={11} />
            </button>
          </>
        )}
        {unsaved && (
          <>
            <div className="h-4 w-px bg-zinc-700" />
            <span className="text-[10px] font-medium text-amber-400">
              Unsaved AI changes
            </span>
            <button
              onClick={() => void saveFiles()}
              className="flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-[10px] font-medium text-white transition hover:bg-emerald-500"
              title="Save files to folder"
            >
              <Save size={11} />
              Save
            </button>
            <button
              onClick={() => void discardChanges()}
              className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[10px] text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-300"
              title="Discard AI changes"
            >
              <Undo2 size={11} />
              Discard
            </button>
          </>
        )}
      </div>
      <div className="flex flex-1 overflow-hidden">
        <div className="min-w-0 flex-1">
          <ActDiagram
            files={files}
            onNavigate={(file, line, col, type) => {
              setPreview({ file, line, col, type });
            }}
            onAiRequest={(prompt, currentFiles) =>
              void handleAiRequest(prompt, currentFiles)
            }
            generating={generating}
          />
        </div>
        {generating && aiStream && (
          <div className="flex h-full w-[40%] max-w-[600px] min-w-[280px] flex-col border-l border-zinc-800 bg-zinc-950">
            <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1">
              <span className="h-2 w-2 animate-pulse rounded-full bg-purple-400" />
              <span className="text-[10px] font-medium text-purple-400">
                Generating...
              </span>
            </div>
            <pre
              ref={aiStreamRef}
              className="flex-1 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-[1.6] text-zinc-400"
            >
              {aiStream}
            </pre>
          </div>
        )}
        {!generating &&
          preview &&
          (() => {
            const fileContent = files.find(
              (f) => f.path === preview.file
            )?.content;
            if (!fileContent) return null;
            return (
              <div className="h-full w-[40%] max-w-[600px] min-w-[280px]">
                <CodePreview
                  filePath={preview.file}
                  content={fileContent}
                  targetLine={preview.line}
                  elementType={preview.type}
                  onClose={() => setPreview(null)}
                />
              </div>
            );
          })()}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DevApp />
  </StrictMode>
);
