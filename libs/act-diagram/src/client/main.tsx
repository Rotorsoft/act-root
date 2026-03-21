import { FolderOpen, RefreshCw } from "lucide-react";
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ActDiagram } from "./components/ActDiagram.js";
import "./styles.css";
import type { FileTab } from "./types/file-tab.js";

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
  return files;
}

function DevApp() {
  const [files, setFiles] = useState<FileTab[]>([]);
  const [folderName, setFolderName] = useState<string>("");
  const dirRef = useRef<FileSystemDirectoryHandle | null>(null);

  const openFolder = useCallback(async () => {
    try {
      const handle = await showDirectoryPicker();
      dirRef.current = handle;
      setFolderName(handle.name);
      const scanned = await readDirectory(handle);
      setFiles(scanned);
    } catch {
      // user cancelled
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!dirRef.current) return;
    const scanned = await readDirectory(dirRef.current);
    setFiles(scanned);
  }, []);

  // Poll for changes every 2s when a folder is open
  useEffect(() => {
    if (!dirRef.current) return;
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
  }, [folderName, refresh]);

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-4 py-2">
        <span className="text-xs font-semibold text-zinc-300">Act Diagram</span>
        <button
          onClick={() => void openFolder()}
          className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-[11px] text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-700"
        >
          <FolderOpen size={12} />
          Open Folder
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
      </div>
      <div className="flex-1">
        {files.length > 0 ? (
          <ActDiagram
            files={files}
            onNavigate={(file, line, col) => {
              console.log(`Navigate to ${file}:${line}:${col}`);
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-zinc-600">
            Open a folder containing an Act project to render its diagram
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DevApp />
  </StrictMode>
);
