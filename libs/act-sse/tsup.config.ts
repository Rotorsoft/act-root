import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: false,
  outDir: "dist",
  clean: true,
  sourcemap: true,
  minify: false,
  target: "es2022",
  tsconfig: "tsconfig.build.json",
  // Inline fast-json-patch into the bundle to avoid CJS/ESM interop issues at runtime.
  // fast-json-patch is CJS-only and Node.js ESM can't do named imports from CJS modules.
  noExternal: ["fast-json-patch"],
});
