import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Stamp the package's own version into the bundle so the diagram can
// show "v0.4.1" in the toolbar at runtime — answers the "what version
// am I looking at?" question without leaving the IDE.
const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};
const define = {
  __ACT_DIAGRAM_VERSION__: JSON.stringify(pkg.version),
};

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
    define,
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
    define,
  },
]);
