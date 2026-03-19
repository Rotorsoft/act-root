import { QueryClientProvider } from "@tanstack/react-query";
import { Builder } from "./Builder.js";
import { queryClient, trpc, trpcClient } from "./trpc.js";

export function App() {
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
          <Builder />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
