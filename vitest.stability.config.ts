/**
 * Runs only the stability spec, which snapshots the published declarations
 * in each package's `dist/`: `pnpm check:stability`, after `pnpm build`.
 * The root config leaves the spec out of `pnpm test`.
 */

import { mergeConfig } from "vitest/config";
import base from "./vite.config.js";

const config = mergeConfig(base, {
  test: {
    include: ["test/stability.spec.ts"],
    coverage: { enabled: false },
  },
});
// mergeConfig appends arrays, and the root exclude names this spec.
config.test.exclude = config.test.exclude.filter(
  (pattern: string) => pattern !== "test/stability.spec.ts"
);

export default config;
