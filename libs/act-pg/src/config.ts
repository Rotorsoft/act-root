import { extend, config as target } from "@rotorsoft/act";
import { z } from "zod";

const { PG_HOST, PG_USER, PG_PASSWORD, PG_DATABASE, PG_PORT } = process.env;

export const config = extend(
  {
    pg: {
      host: PG_HOST || "localhost",
      user: PG_USER || "postgres",
      password: PG_PASSWORD || "postgres",
      database: PG_DATABASE || "postgres",
      port: Number.parseInt(PG_PORT || "5432"),
    },
  },
  z.object({
    pg: z.object({
      host: z.string().min(1),
      user: z.string().min(1),
      password: z.string().min(1),
      database: z.string().min(1),
      port: z.number().int().min(1000).max(65535),
    }),
  }),
  target()
);
