import { QueryClient } from "@tanstack/react-query";
import { createTRPCReact, httpLink } from "@trpc/react-query";
import type { Router } from "../../server/src/router";

export const trpc = createTRPCReact<Router>();
export const queryClient = new QueryClient({});
export const client = trpc.createClient({
  links: [httpLink({ url: "http://localhost:4000" })],
});
