import * as path from "node:path";
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
      "@rotorsoft/act-http/webhook": path.resolve(
        __dirname,
        "libs/act-http/src/webhook/index.ts"
      ),
      "@rotorsoft/act-http/sse": path.resolve(
        __dirname,
        "libs/act-http/src/sse/index.ts"
      ),
      "@rotorsoft/act-http/receiver/trpc": path.resolve(
        __dirname,
        "libs/act-http/src/receiver/trpc/index.ts"
      ),
      "@rotorsoft/act-http/receiver/express": path.resolve(
        __dirname,
        "libs/act-http/src/receiver/express/index.ts"
      ),
      "@rotorsoft/act-http/receiver/fastify": path.resolve(
        __dirname,
        "libs/act-http/src/receiver/fastify/index.ts"
      ),
      "@rotorsoft/act-http/receiver/hono": path.resolve(
        __dirname,
        "libs/act-http/src/receiver/hono/index.ts"
      ),
      "@rotorsoft/act-http/receiver": path.resolve(
        __dirname,
        "libs/act-http/src/receiver/index.ts"
      ),
      "@rotorsoft/act-pino": path.resolve(
        __dirname,
        "libs/act-pino/src/index.ts"
      ),
      "@rotorsoft/act-ops/idempotency": path.resolve(
        __dirname,
        "libs/act-ops/src/idempotency/index.ts"
      ),
      "@rotorsoft/act-sqlite": path.resolve(
        __dirname,
        "libs/act-sqlite/src/index.ts"
      ),
      "@rotorsoft/act/test": path.resolve(
        __dirname,
        "libs/act/src/test/index.ts"
      ),
      "@rotorsoft/act/types": path.resolve(
        __dirname,
        "libs/act/src/types/index.ts"
      ),
      "@rotorsoft/act": path.resolve(__dirname, "libs/act/src/index.ts"),
      "@rotorsoft/act-tck": path.resolve(
        __dirname,
        "libs/act-tck/src/index.ts"
      ),
    },
  },
  test: {
    globals: true,
    // picocolors enables color emission when `CI` is set in env, which
    // wraps act-diagram CLI output in ANSI escapes and breaks
    // plain-text `toContain` assertions in format.spec/repl.spec. Force
    // picocolors off in tests so output is deterministic across local
    // and CI runs; `colors.spec.ts` mocks picocolors directly and is
    // unaffected.
    env: {
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["libs/**/src/**/*.ts"],
      exclude: [
        "**/node_modules/**",
        "packages/**",
        "**/*.tsx",
        "libs/act-diagram/src/server/**",
        "libs/act-diagram/src/client/data/**",
        "libs/act-diagram/src/client/components/**",
        "libs/act-diagram/src/client/main.tsx",
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
