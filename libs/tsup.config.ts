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
});
