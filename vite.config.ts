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
      provider: "istanbul",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
      include: ["libs/**/src/**/*.ts"],
      exclude: ["**/node_modules/**", "libs/act-examples"],
      thresholds: {
        branches: 85,
        functions: 90,
        lines: 95,
        statements: 95,
      },
    },
  },
});
