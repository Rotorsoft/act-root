import { QueryClient } from "@tanstack/react-query";
import {
  type CreateTRPCReact,
  createTRPCReact,
  httpLink,
} from "@trpc/react-query";
import { type InspectorRouter } from "../server/router.js";

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

export const trpcClient = trpc.createClient({
  links: [httpLink({ url: "http://localhost:4001" })],
});
