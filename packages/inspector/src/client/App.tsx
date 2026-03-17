import { QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { ConnectDialog } from "./components/ConnectDialog.js";
import { Header } from "./components/Header.js";
import { TabNav, type Tab } from "./components/TabNav.js";
import { queryClient, trpc, trpcClient } from "./trpc.js";
import { Correlation } from "./views/Correlation.js";
import { EventLog } from "./views/EventLog.js";
import { Streams } from "./views/Streams.js";
import { Timeline } from "./views/Timeline.js";

export type ViewState = {
  tab: Tab;
  correlation?: string;
  stream?: string;
};

/** Human-readable caption for a view state */
export function viewCaption(v: ViewState): string {
  if (v.tab === "correlation" && v.correlation) {
    return `Correlation ${v.correlation.slice(0, 8)}...`;
  }
  if (v.tab === "streams" && v.stream) {
    const short = v.stream.length > 24 ? `...${v.stream.slice(-21)}` : v.stream;
    return `Stream ${short}`;
  }
  const labels: Record<Tab, string> = {
    log: "Event Log",
    timeline: "Timeline",
    streams: "Streams",
    correlation: "Correlation",
  };
  return labels[v.tab];
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [showConnect, setShowConnect] = useState(true);
  const [connectionName, setConnectionName] = useState("");
  const [connectionKey, setConnectionKey] = useState(0);

  // Navigation history
  const [view, setView] = useState<ViewState>({ tab: "log" });
  const historyStack = useRef<ViewState[]>([{ tab: "log" }]);
  const historyIndex = useRef(0);
  const isNavigating = useRef(false);
  // Force re-render when history changes (refs don't trigger renders)
  const [, setHistoryVersion] = useState(0);

  const navigateTo = useCallback((next: ViewState) => {
    if (isNavigating.current) return;
    historyStack.current = historyStack.current.slice(
      0,
      historyIndex.current + 1
    );
    historyStack.current.push(next);
    historyIndex.current = historyStack.current.length - 1;
    setView(next);
    setHistoryVersion((v) => v + 1);
  }, []);

  const goTo = useCallback((index: number) => {
    if (index < 0 || index >= historyStack.current.length) return;
    isNavigating.current = true;
    historyIndex.current = index;
    setView(historyStack.current[index]);
    setHistoryVersion((v) => v + 1);
    isNavigating.current = false;
  }, []);

  const goBack = useCallback(() => goTo(historyIndex.current - 1), [goTo]);
  const goForward = useCallback(() => goTo(historyIndex.current + 1), [goTo]);

  const canGoBack = historyIndex.current > 0;
  const canGoForward = historyIndex.current < historyStack.current.length - 1;

  const handleConnected = (name: string) => {
    queryClient.clear();
    setConnected(true);
    setConnectionName(name);
    setConnectionKey((k) => k + 1);
    setShowConnect(false);
    historyStack.current = [{ tab: "log" }];
    historyIndex.current = 0;
    setView({ tab: "log" });
    setHistoryVersion((v) => v + 1);
  };

  const handleTabChange = (tab: Tab) => navigateTo({ tab });
  const handleTrace = (correlationId: string) =>
    navigateTo({ tab: "correlation", correlation: correlationId });
  const handleStream = (stream: string) =>
    navigateTo({ tab: "streams", stream });

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
          <Header
            connected={connected}
            connectionName={connectionName}
            onConnect={() => setShowConnect(true)}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            onBack={goBack}
            onForward={goForward}
            history={historyStack.current}
            historyIndex={historyIndex.current}
            onGoTo={goTo}
          />
          {showConnect && (
            <ConnectDialog
              onConnected={handleConnected}
              onClose={connected ? () => setShowConnect(false) : undefined}
            />
          )}
          {connected && (
            <>
              <TabNav active={view.tab} onChange={handleTabChange} />
              <div key={connectionKey} className="flex min-h-0 flex-1 flex-col">
                {view.tab === "log" && (
                  <EventLog onTrace={handleTrace} onStream={handleStream} />
                )}
                {view.tab === "timeline" && (
                  <Timeline onTrace={handleTrace} onStream={handleStream} />
                )}
                {view.tab === "streams" && (
                  <Streams
                    initialStream={view.stream}
                    onTrace={handleTrace}
                    onStream={handleStream}
                  />
                )}
                {view.tab === "correlation" && (
                  <Correlation
                    initialCorrelation={view.correlation}
                    onStream={handleStream}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
