/// <reference types="vitest" />
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    coverage: {
      provider: "istanbul",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
      include: ["libs/**/src/**/*.ts"],
      exclude: ["**/node_modules/**", "packages/**"],
      thresholds: {
        branches: 90,
        functions: 95,
        lines: 95,
        statements: 95,
      },
    },
  },
});
