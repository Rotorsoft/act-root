/// <reference types="vitest" />
import * as path from "path";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@rotorsoft/act": path.resolve(__dirname, "libs/act/src/index.ts"),
    },
  },
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
      include: ["libs/**/src/**/*.ts"],
      exclude: ["**/node_modules/**", "packages/**"],
      thresholds: {
        branches: 95,
        functions: 95,
        lines: 95,
        statements: 95,
      },
    },
  },
});
