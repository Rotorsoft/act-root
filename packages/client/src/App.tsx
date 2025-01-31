import { QueryClientProvider } from "@tanstack/react-query";
import Calculator from "./Calculator";
import { client, queryClient, trpc } from "./trpc";

export default function App() {
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Calculator />
      </QueryClientProvider>
    </trpc.Provider>
  );
}
