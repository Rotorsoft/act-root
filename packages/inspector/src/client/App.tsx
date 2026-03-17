import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ConnectDialog } from "./components/ConnectDialog.js";
import { Header } from "./components/Header.js";
import { TabNav, type Tab } from "./components/TabNav.js";
import { queryClient, trpc, trpcClient } from "./trpc.js";
import { EventLog } from "./views/EventLog.js";
import { Streams } from "./views/Streams.js";
import { Timeline } from "./views/Timeline.js";

export default function App() {
  const [connected, setConnected] = useState(false);
  const [showConnect, setShowConnect] = useState(true);
  const [connectionName, setConnectionName] = useState("");
  const [connectionKey, setConnectionKey] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>("log");

  const handleConnected = (name: string) => {
    queryClient.clear();
    setConnected(true);
    setConnectionName(name);
    setConnectionKey((k) => k + 1);
    setShowConnect(false);
  };

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
          <Header
            connected={connected}
            connectionName={connectionName}
            onConnect={() => setShowConnect(true)}
          />
          {showConnect && (
            <ConnectDialog
              onConnected={handleConnected}
              onClose={connected ? () => setShowConnect(false) : undefined}
            />
          )}
          {connected && (
            <>
              <TabNav active={activeTab} onChange={setActiveTab} />
              <div key={connectionKey} className="flex min-h-0 flex-1 flex-col">
                {activeTab === "log" && <EventLog />}
                {activeTab === "timeline" && <Timeline />}
                {activeTab === "streams" && (
                  <Streams onNavigateToLog={() => setActiveTab("log")} />
                )}
              </div>
            </>
          )}
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
