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
  dts: false,
  outDir: "dist",
  clean: true,
  sourcemap: true,
  minify: false,
  target: "es2022",
  tsconfig: "tsconfig.build.json",
});
