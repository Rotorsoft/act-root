import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ConnectDialog } from "./components/ConnectDialog.js";
import { Header } from "./components/Header.js";
import { queryClient, trpc, trpcClient } from "./trpc.js";
import { EventLog } from "./views/EventLog.js";

export default function App() {
  const [connected, setConnected] = useState(false);
  const [showConnect, setShowConnect] = useState(true);
  const [connectionName, setConnectionName] = useState("");
  const [connectionKey, setConnectionKey] = useState(0);

  const handleConnected = (name: string) => {
    // Clear all cached queries from previous connection
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
          {connected && <EventLog key={connectionKey} />}
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
