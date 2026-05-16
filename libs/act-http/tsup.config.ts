import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/webhook/index.ts", "src/sse/index.ts"],
  format: ["esm", "cjs"],
  dts: false,
  outDir: "dist",
  clean: true,
  sourcemap: true,
  minify: false,
  target: "es2022",
  tsconfig: "tsconfig.build.json",
});
