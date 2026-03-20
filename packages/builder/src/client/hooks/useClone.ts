import { useCallback, useRef, useState } from "react";

export interface CloneParams {
  owner: string;
  repo: string;
  branch: string;
  entryPath?: string;
}

export interface CloneResult {
  files: { path: string; content: string }[];
}

export interface UseCloneOptions {
  onComplete: (result: CloneResult) => void;
}

export interface UseCloneReturn {
  clonePending: boolean;
  cloneLog: string[];
  cloneError: string | null;
  startClone: (parsed: CloneParams) => void;
}

export function useClone({ onComplete }: UseCloneOptions): UseCloneReturn {
  const [clonePending, setClonePending] = useState(false);
  const [cloneLog, setCloneLog] = useState<string[]>([]);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const cloneAbortRef = useRef<AbortController | null>(null);

  const startClone = useCallback(
    (parsed: CloneParams) => {
      cloneAbortRef.current?.abort();
      const ctrl = new AbortController();
      cloneAbortRef.current = ctrl;
      setClonePending(true);
      setCloneLog([]);
      setCloneError(null);

      void (async () => {
        try {
          const res = await fetch("http://localhost:4002/clone-stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(parsed),
            signal: ctrl.signal,
          });
          const reader = res.body?.getReader();
          if (!reader) throw new Error("No response body");
          const decoder = new TextDecoder();
          let buf = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              const json = line.replace(/^data: /, "").trim();
              if (!json) continue;
              try {
                const msg = JSON.parse(json) as {
                  type: string;
                  text?: string;
                  message?: string;
                  files?: { path: string; content: string }[];
                };
                if (msg.type === "status" && msg.text) {
                  setCloneLog((prev) => [...prev, msg.text!]);
                } else if (msg.type === "done" && msg.files) {
                  onComplete({ files: msg.files });
                } else if (msg.type === "error") {
                  setCloneError(msg.message ?? "Clone failed");
                }
              } catch {
                // skip malformed SSE
              }
            }
          }
        } catch (err) {
          if ((err as Error).name !== "AbortError") {
            setCloneError(err instanceof Error ? err.message : "Clone failed");
          }
        } finally {
          setClonePending(false);
        }
      })();
    },
    [onComplete]
  );

  return { clonePending, cloneLog, cloneError, startClone };
}
