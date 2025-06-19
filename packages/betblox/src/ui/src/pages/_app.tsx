import "../app/globals.css";
import type { AppProps } from "next/app";
import { NavBar } from "../components/NavBar";
import { trpc } from "../trpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { httpBatchLink } from "@trpc/client";

function MyApp({ Component, pageProps }: AppProps) {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: process.env.NEXT_PUBLIC_TRPC_URL || "http://localhost:4000/trpc",
        }),
      ],
    })
  );

  return (
    <>
      <NavBar />
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <Component {...pageProps} />
        </QueryClientProvider>
      </trpc.Provider>
    </>
  );
}

export default MyApp;
