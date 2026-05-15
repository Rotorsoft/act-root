import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: false,
    outDir: "dist",
    clean: true,
    sourcemap: true,
    minify: false,
    target: "es2022",
    tsconfig: "tsconfig.build.json",
    external: ["react", "react-dom", "lucide-react"],
  },
  {
    // Node-only CLI bundle. ESM, banner-stamped with shebang.
    entry: { "cli/act": "src/cli/index.ts" },
    format: ["esm"],
    dts: false,
    outDir: "dist",
    clean: false,
    sourcemap: true,
    minify: false,
    target: "node22",
    platform: "node",
    tsconfig: "tsconfig.build.json",
    external: ["react", "react-dom", "lucide-react"],
    banner: { js: "#!/usr/bin/env node" },
  },
]);
