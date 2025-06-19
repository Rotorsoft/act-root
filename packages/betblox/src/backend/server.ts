import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import "dotenv/config";
import Fastify from "fastify";
import { z } from "zod";
import { BetBloxEvent } from "../act/schemas";
import { projectEvent } from "./projection";
import { mockContractEvents } from "./smart-contract-mock";
import { appRouter } from "./trpc";

const envSchema = z.object({
  PGHOST: z.string().min(1, "PGHOST is required"),
  PGPORT: z.string().min(1, "PGPORT is required"),
  PGUSER: z.string().min(1, "PGUSER is required"),
  PGPASSWORD: z.string().min(1, "PGPASSWORD is required"),
  PGDATABASE: z.string().min(1, "PGDATABASE is required"),
});

envSchema.parse(process.env);

const fastify = Fastify({ logger: true });

// Health check route
fastify.get("/health", () => ({ status: "ok" }));

// tRPC plugin
fastify.register(fastifyTRPCPlugin, {
  prefix: "/trpc",
  trpcOptions: { router: appRouter, createContext: () => ({}) },
});

// Mock smart contract event emitter (for local/dev)
mockContractEvents(async (event: BetBloxEvent) => {
  try {
    await projectEvent(event);
    fastify.log.info({ event }, "Projected event to DB");
  } catch (err) {
    fastify.log.error({ err, event }, "Failed to project event");
  }
});

const start = async () => {
  try {
    await fastify.listen({ port: 4000, host: "0.0.0.0" });
    console.log("🚀 Fastify server running on http://localhost:4000");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

void start();
