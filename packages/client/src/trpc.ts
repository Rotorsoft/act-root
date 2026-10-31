import type { AppRouter } from "@act/server";
import { QueryClient } from "@tanstack/react-query";
import {
  type CreateTRPCReact,
  createTRPCReact,
  httpLink,
  httpSubscriptionLink,
  splitLink,
} from "@trpc/react-query";

export const SERVER_BASE = "http://localhost:4000";

export const trpc: CreateTRPCReact<AppRouter, unknown> =
  createTRPCReact<AppRouter>();
export const queryClient = new QueryClient({});
export const client = trpc.createClient({
  // The server bridges `/trpc/*` to its tRPC handler. Subscriptions
  // (the generated `subscribe.<state>`) stream over SSE; mutations are
  // plain HTTP.
  links: [
    splitLink({
      condition: (op) => op.type === "subscription",
      true: httpSubscriptionLink({ url: `${SERVER_BASE}/trpc` }),
      false: httpLink({ url: `${SERVER_BASE}/trpc` }),
    }),
  ],
});
