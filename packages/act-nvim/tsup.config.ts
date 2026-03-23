import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server/relay.ts"],
  format: ["esm"],
  outDir: "dist/server",
  target: "node22",
  clean: true,
  sourcemap: true,
  minify: false,
});
