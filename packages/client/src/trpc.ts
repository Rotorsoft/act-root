import { type CalculatorRouter } from "@act/calculator";
import { QueryClient } from "@tanstack/react-query";
import {
  type CreateTRPCReact,
  createTRPCReact,
  httpLink,
} from "@trpc/react-query";

export const trpc: CreateTRPCReact<CalculatorRouter, unknown> =
  createTRPCReact<CalculatorRouter>();
export const queryClient = new QueryClient({});
export const client = trpc.createClient({
  links: [httpLink({ url: "http://localhost:4000" })],
});
