/**
 * VS Code Workbench container — mounts the full workbench with file explorer,
 * editor tabs, and TypeScript IntelliSense. Syncs project files to the virtual
 * filesystem and opens Act-relevant files automatically.
 */
import * as monaco from "@codingame/monaco-vscode-editor-api";
import type { InMemoryFileSystemProvider } from "@codingame/monaco-vscode-files-service-override";
import { useEffect, useRef, useState } from "react";
import {
  closeAllEditors,
  initVscodeWorkbench,
  openFileInEditor,
  triggerResize,
  WORKSPACE,
  writeWorkspaceFile,
} from "../lib/vscode-init.js";
import type { FileTab } from "../types/index.js";

/** Pattern to identify Act-relevant files worth auto-opening */
const ACT_FILE_RE =
  /(?:state|slice|projection|act)\s*\(|\.withState\(|\.withSlice\(|\.emits\(/;

type Props = {
  files: FileTab[];
  onFileChange: (index: number, content: string) => void;
};

export function CodeEditor({ files, onFileChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fsRef = useRef<InMemoryFileSystemProvider | null>(null);
  const [ready, setReady] = useState(false);
  const prevFilesRef = useRef<string>("");

  const filesRef = useRef(files);
  filesRef.current = files;
  const onFileChangeRef = useRef(onFileChange);
  onFileChangeRef.current = onFileChange;

  // ── Initialize workbench once ──────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;

    async function init(container: HTMLElement) {
      try {
        const { fs } = await initVscodeWorkbench(container);
        if (disposed) return;
        fsRef.current = fs;
        setReady(true);
      } catch (err) {
        console.warn("Workbench init error:", err);
      }
    }

    const el = containerRef.current;
    if (el.offsetWidth > 0 && el.offsetHeight > 0) {
      void init(el);
    } else {
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
            observer.disconnect();
            if (!disposed) void init(el);
            break;
          }
        }
      });
      observer.observe(el);
      return () => {
        disposed = true;
        observer.disconnect();
      };
    }

    return () => {
      disposed = true;
    };
  }, []);

  // ── Sync files to virtual filesystem ──────────────────────────────
  useEffect(() => {
    if (!fsRef.current || !ready) return;

    // Compute a fingerprint to detect project changes (not just content edits)
    const fingerprint = files.map((f) => f.path).join("\n");
    const isNewProject = fingerprint !== prevFilesRef.current;
    prevFilesRef.current = fingerprint;

    // On project load, write files and open relevant ones
    if (isNewProject && files.length > 0) {
      void (async () => {
        await closeAllEditors();

        // Write files: package.json first (creates node_modules entries for
        // workspace packages), then config, then TS sources
        const sorted = [...files].sort((a, b) => {
          const rank = (p: string) =>
            p.endsWith("package.json")
              ? 0
              : p.endsWith(".json") || p.endsWith(".yaml")
                ? 1
                : 2;
          return rank(a.path) - rank(b.path);
        });
        for (const f of sorted) {
          await writeWorkspaceFile(fsRef.current!, f.path, f.content);
        }

        triggerResize();

        // Open Act-relevant files
        const actFiles = files.filter(
          (f) => f.path.endsWith(".ts") && ACT_FILE_RE.test(f.content)
        );
        if (actFiles.length > 0) {
          for (let j = 0; j < actFiles.length; j++) {
            await openFileInEditor(actFiles[j].path, j > 0);
          }
        } else {
          const first = files.find((f) => f.path.endsWith(".ts")) ?? files[0];
          if (first) await openFileInEditor(first.path);
        }

        // Show explorer
        try {
          const vscode = await import("vscode");
          await vscode.commands.executeCommand("workbench.view.explorer");
        } catch {
          // best effort
        }
      })();
    } else if (!isNewProject) {
      // Content edit — just update the changed file
      for (const f of files) {
        void writeWorkspaceFile(fsRef.current, f.path, f.content);
      }
    }
  }, [files, ready]);

  // ── Listen for content changes from the workbench editors ──────────
  useEffect(() => {
    if (!ready) return;

    const wsPrefix = `file://${WORKSPACE}/`;

    const disposables: { dispose(): void }[] = [];

    function attachListener(model: monaco.editor.ITextModel) {
      const uriStr = model.uri.toString();
      if (!uriStr.startsWith(wsPrefix)) return;
      disposables.push(
        model.onDidChangeContent(() => {
          const path = uriStr.slice(wsPrefix.length);
          const idx = filesRef.current.findIndex(
            (f: FileTab) => f.path === path
          );
          if (idx >= 0) {
            onFileChangeRef.current(idx, model.getValue());
          }
        })
      );
    }

    for (const m of monaco.editor.getModels()) attachListener(m);
    disposables.push(monaco.editor.onDidCreateModel((m) => attachListener(m)));

    return () => {
      for (const d of disposables) d.dispose();
    };
  }, [ready]);

  return (
    <div
      className="relative min-h-0 flex-1 overflow-hidden"
      style={{ height: "100%" }}
    >
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%", overflow: "hidden" }}
      />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-950 text-xs text-zinc-600">
          Initializing editor...
        </div>
      )}
    </div>
  );
}
