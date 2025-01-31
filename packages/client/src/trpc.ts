import { QueryClient } from "@tanstack/react-query";
import { createTRPCReact, httpBatchLink } from "@trpc/react-query";
import type { Router } from "../../server/src/router";

export const trpc = createTRPCReact<Router>();
export const queryClient = new QueryClient({});
export const client = trpc.createClient({
  links: [
    httpBatchLink({
      url: "http://localhost:4000/trpc",
      headers: () => {
        return {
          "x-stream": "Calculator-A",
        };
      },
    }),
  ],
});
