import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../../backend/trpc";

export const trpc = createTRPCReact<AppRouter>();
