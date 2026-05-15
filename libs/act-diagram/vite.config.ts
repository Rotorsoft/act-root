import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Stamp the package version into both prod (tsup) and dev (Vite) builds
// so the toolbar can show what's running without leaving the editor.
const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 3002 },
  define: {
    __ACT_DIAGRAM_VERSION__: JSON.stringify(`${pkg.version}-dev`),
  },
});
