import { useEffect, useRef, useState } from "react";
import { getWorkspaceErrors } from "../lib/vscode-init.js";
import type { FileTab } from "../types/index.js";

export interface UseEditorErrorsReturn {
  editorErrorCount: number;
  setEditorErrorCount: (count: number) => void;
}

export function useEditorErrors(files: FileTab[]): UseEditorErrorsReturn {
  const [editorErrorCount, setEditorErrorCount] = useState(0);

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

  return { editorErrorCount, setEditorErrorCount };
}
