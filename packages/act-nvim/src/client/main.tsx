import type { FileTab, HostMessage } from "@rotorsoft/act-diagram";
import {
  Diagram,
  extractModel,
  navigateToCode,
  validate,
} from "@rotorsoft/act-diagram";
import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const WS_URL = `ws://${window.location.host}/ws`;
const RECONNECT_MS = 1000;

function App() {
  const [files, setFiles] = useState<FileTab[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    function connect() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (active) setConnected(true);
      };

      ws.onmessage = (e) => {
        if (!active) return;
        try {
          const msg: HostMessage = JSON.parse(e.data as string);
          switch (msg.type) {
            case "files":
              setFiles(msg.files);
              break;
            case "fileAdded":
              setFiles((prev) => [
                ...prev,
                { path: msg.path, content: msg.content },
              ]);
              break;
            case "fileChanged":
              setFiles((prev) => {
                const idx = prev.findIndex((f) => f.path === msg.path);
                if (idx < 0)
                  return [...prev, { path: msg.path, content: msg.content }];
                const next = [...prev];
                next[idx] = { path: msg.path, content: msg.content };
                return next;
              });
              break;
            case "fileDeleted":
              setFiles((prev) => prev.filter((f) => f.path !== msg.path));
              break;
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        if (!active) return;
        setConnected(false);
        wsRef.current = null;
        timer = setTimeout(connect, RECONNECT_MS);
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      active = false;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, []);

  const { model, warnings, error } = useMemo(() => {
    if (files.length === 0)
      return {
        model: {
          entries: [],
          states: [],
          slices: [],
          projections: [],
          reactions: [],
        },
        warnings: [],
        error: undefined,
      };
    const { model, error } = extractModel(files);
    const warnings = validate(model);
    return { model, warnings, error };
  }, [files]);

  const handleClick = useCallback(
    (name: string, type?: string, file?: string) => {
      const result = navigateToCode(files, name, type, file);
      if (!result) return;
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "navigate",
            file: result.file,
            line: result.line,
            col: result.col,
          })
        );
      }
    },
    [files]
  );

  return (
    <div className="h-full w-full flex flex-col bg-[#0a0a0a]">
      {!connected && (
        <div className="absolute top-2 right-2 z-50 rounded bg-red-900/80 px-3 py-1 text-xs text-red-200">
          Disconnected — reconnecting...
        </div>
      )}
      {error && (
        <div className="shrink-0 border-b border-red-900/50 bg-red-950/50 px-4 py-2 text-xs text-red-300">
          <span className="font-semibold text-red-400">Extraction error: </span>
          <span className="font-mono">{error}</span>
        </div>
      )}
      {files.length === 0 ? (
        <div className="flex h-full items-center justify-center text-zinc-500 text-sm">
          {connected
            ? "Waiting for files from Neovim..."
            : "Connecting to relay server..."}
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <Diagram
            model={model}
            warnings={warnings}
            onClickElement={handleClick}
          />
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
