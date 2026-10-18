import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/types/index.ts", "src/test/index.ts"],
  // vitest must stay external: the /test subpath builds on vitest's
  // test.extend, which only works inside the consumer's own vitest
  // instance. Bundling a private copy of the runner (the default for
  // devDependencies) breaks fixture() for every external consumer with
  // "Vitest failed to find the current suite".
  external: ["vitest"],
  format: ["esm", "cjs"],
  // Share one copy of each class across entry points in both formats:
  // without it every CommonJS entry carries its own, and `instanceof`
  // fails for an error thrown by one entry and checked against another.
  splitting: true,
  dts: false,
  outDir: "dist",
  clean: true,
  sourcemap: true,
  minify: false,
  target: "es2022",
  tsconfig: "tsconfig.build.json",
});
