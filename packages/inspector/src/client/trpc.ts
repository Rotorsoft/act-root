import { QueryClient } from "@tanstack/react-query";
import { httpLink, httpSubscriptionLink, splitLink } from "@trpc/client";
import { type CreateTRPCReact, createTRPCReact } from "@trpc/react-query";
import type { InspectorRouter } from "../server/router.js";

export const trpc: CreateTRPCReact<InspectorRouter, unknown> =
  createTRPCReact<InspectorRouter>();

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

// `splitLink` routes subscriptions over SSE (`httpSubscriptionLink`)
// and everything else over the existing `httpLink`. This keeps the
// server on a plain HTTP adapter (no WS) while still pushing
// reactive `restoreProgress` events to the client (ACT-1128).
const url = (import.meta.env.VITE_API_URL as string) || "/trpc";
export const trpcClient = trpc.createClient({
  links: [
    splitLink({
      condition: (op) => op.type === "subscription",
      true: httpSubscriptionLink({ url }),
      false: httpLink({ url }),
    }),
  ],
});
