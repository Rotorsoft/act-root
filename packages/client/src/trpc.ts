import type { CalculatorRouter } from "@act/calculator";
import { QueryClient } from "@tanstack/react-query";
import {
  type CreateTRPCReact,
  createTRPCReact,
  httpLink,
} from "@trpc/react-query";

export const SERVER_BASE = "http://localhost:4000";

export const trpc: CreateTRPCReact<CalculatorRouter, unknown> =
  createTRPCReact<CalculatorRouter>();
export const queryClient = new QueryClient({});
export const client = trpc.createClient({
  // The server bridges `/trpc/*` to its tRPC handler — match the
  // multi-transport server's URL convention.
  links: [httpLink({ url: `${SERVER_BASE}/trpc` })],
});
