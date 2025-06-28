import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./src/drizzle",
  schema: "./src/drizzle/schema.ts",
  dialect: "sqlite",
  dbCredentials: { url: "file:local.db" },
});
