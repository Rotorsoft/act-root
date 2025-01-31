/// <reference types="vitest" />
import * as dotenv from "dotenv";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

dotenv.config();

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    coverage: {
      include: ["libs/**/src/**/*.ts"],
      exclude: ["**/node_modules", "libs/act-examples"],
      provider: "istanbul",
      reportsDirectory: "./coverage",
    },
  },
});
