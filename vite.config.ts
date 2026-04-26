import * as path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@rotorsoft/act-patch": path.resolve(
        __dirname,
        "libs/act-patch/src/index.ts"
      ),
      "@rotorsoft/act-sse": path.resolve(
        __dirname,
        "libs/act-sse/src/index.ts"
      ),
      "@rotorsoft/act-pino": path.resolve(
        __dirname,
        "libs/act-pino/src/index.ts"
      ),
      "@rotorsoft/act-sqlite": path.resolve(
        __dirname,
        "libs/act-sqlite/src/index.ts"
      ),
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
      exclude: [
        "**/node_modules/**",
        "packages/**",
        "libs/act-diagram/src/server/**",
        "libs/act-diagram/src/client/data/**",
        "libs/act-diagram/src/client/components/**",
        "libs/act-diagram/src/client/types/protocol.ts",
        "libs/act-diagram/src/client/types/file-tab.ts",
        "libs/act-diagram/src/client/types/index.ts",
        "libs/act-diagram/src/index.ts",
        "libs/act-diagram/src/vite-env.d.ts",
      ],
      thresholds: {
        branches: 90,
        functions: 95,
        lines: 95,
        statements: 95,
      },
    },
  },
});
