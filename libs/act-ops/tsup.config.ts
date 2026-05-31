import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "idempotency/index": "src/idempotency/index.ts",
    "receiver/index": "src/receiver/index.ts",
  },
  format: ["esm", "cjs"],
  dts: false,
  outDir: "dist",
  clean: true,
  sourcemap: true,
  minify: false,
  target: "es2022",
  tsconfig: "tsconfig.build.json",
});
