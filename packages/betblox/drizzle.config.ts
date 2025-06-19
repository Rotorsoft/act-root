import type { Config } from "drizzle-kit";

export default {
  schema: "./src/act/schema.drizzle.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    host: process.env.PG_HOST || "localhost",
    port: process.env.PG_PORT ? Number(process.env.PG_PORT) : 5432,
    user: process.env.PG_USER || "betblox",
    password: process.env.PG_PASSWORD || "betblox",
    database: process.env.PG_DATABASE || "betblox",
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false,
  },
} satisfies Config;
