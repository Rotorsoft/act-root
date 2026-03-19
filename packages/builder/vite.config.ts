import importMetaUrlPlugin from "@codingame/esbuild-import-meta-url-plugin";
import vsixPlugin from "@codingame/monaco-vscode-rollup-vsix-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync, readdirSync } from "fs";
import { request as httpsGet } from "https";
import { join } from "path";
import { defineConfig, type Plugin } from "vite";

/**
 * Dev-mode middleware that serves VSCode extension resources.
 * The vsix plugin only bundles resources at build time.
 * In dev mode, requests for /node_modules/.vite/deps/resources/<file>
 * need to be resolved from the actual extension packages.
 */
function vsixDevPlugin(): Plugin {
  const extensionPkgs = [
    "@codingame/monaco-vscode-theme-defaults-default-extension",
    "@codingame/monaco-vscode-typescript-basics-default-extension",
    "@codingame/monaco-vscode-typescript-language-features-default-extension",
    "@codingame/monaco-vscode-javascript-default-extension",
  ];

  let resourceMap: Map<string, string>;

  function buildResourceMap() {
    if (resourceMap) return resourceMap;
    resourceMap = new Map();
    const pnpmDir = join(process.cwd(), "../..", "node_modules/.pnpm");
    for (const pkg of extensionPkgs) {
      const pkgDir = pkg.replace("@codingame/", "@codingame+");
      const candidates = readdirSync(pnpmDir).filter((d) =>
        d.startsWith(pkgDir + "@25")
      );
      for (const candidate of candidates) {
        const resDir = join(
          pnpmDir,
          candidate,
          "node_modules",
          ...pkg.split("/"),
          "resources"
        );
        if (existsSync(resDir)) {
          for (const file of readdirSync(resDir)) {
            resourceMap.set(file, join(resDir, file));
          }
        }
      }
    }
    return resourceMap;
  }

  return {
    name: "vsix-dev-resources",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        const match =
          url.match(
            /\/node_modules\/\.vite\/(?:deps\/resources|deps|worker)\/([^?]+)/
          ) ?? (url.includes("onig.wasm") ? ["", "onig.wasm"] : null);
        if (!match) return next();

        const filename = decodeURIComponent(match[1]);
        const map = buildResourceMap();
        let filePath = map.get(filename);

        if (!filePath && filename.endsWith(".wasm")) {
          const wasmPath = join(
            process.cwd(),
            "../..",
            "node_modules/.pnpm/@codingame+monaco-vscode-textmate-service-override@25.1.2/node_modules/@codingame/monaco-vscode-textmate-service-override/external/vscode-oniguruma/release",
            filename
          );
          if (existsSync(wasmPath)) filePath = wasmPath;
        }

        if (filePath && existsSync(filePath)) {
          const content = readFileSync(filePath);
          const ext = filename.split(".").pop() ?? "";
          const mimeTypes: Record<string, string> = {
            json: "application/json",
            js: "application/javascript",
            svg: "image/svg+xml",
            png: "image/png",
            wasm: "application/wasm",
            tmLanguage: "application/xml",
          };
          res.setHeader(
            "Content-Type",
            mimeTypes[ext] || "application/octet-stream"
          );
          res.setHeader("Cache-Control", "public, max-age=31536000");
          res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
          res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
          res.end(content);
        } else {
          next();
        }
      });
    },
  };
}

/** Serve extension-file:// resources via HTTP for the tsserver Worker */
function extensionFilePlugin(): Plugin {
  return {
    name: "extension-file-dev",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/extension-file/")) return next();
        const rest = url.slice("/extension-file/".length);
        const slashIdx = rest.indexOf("/");
        if (slashIdx < 0) return next();
        const extId = rest.slice(0, slashIdx);
        let filePath = rest.slice(slashIdx + 1);
        for (const prefix of [
          "extension/dist/browser/typescript/",
          "extension/dist/browser/",
          "extension/dist/",
          "extension/",
        ]) {
          if (filePath.startsWith(prefix)) {
            filePath = filePath.slice(prefix.length);
            break;
          }
        }
        const pkgMap: Record<string, string> = {
          "vscode.typescript-language-features":
            "@codingame+monaco-vscode-typescript-language-features-default-extension@25.1.2",
          "vscode.typescript-basics":
            "@codingame+monaco-vscode-typescript-basics-default-extension@25.1.2",
          "vscode.javascript":
            "@codingame+monaco-vscode-javascript-default-extension@25.1.2",
          "vscode.theme-defaults":
            "@codingame+monaco-vscode-theme-defaults-default-extension@25.1.2",
        };
        const pnpmPkg = pkgMap[extId];
        if (!pnpmPkg) return next();
        const resDir = join(
          process.cwd(),
          "../..",
          `node_modules/.pnpm/${pnpmPkg}/node_modules/@codingame/${pnpmPkg.split("@25")[0].replace("@codingame+", "")}/resources`
        );
        let fullPath = join(resDir, filePath);
        if (!existsSync(fullPath) && existsSync(fullPath + ".txt"))
          fullPath += ".txt";
        if (!existsSync(fullPath)) return next();
        const content = readFileSync(fullPath);
        const ext = filePath.split(".").pop() ?? "";
        const mimeTypes: Record<string, string> = {
          js: "application/javascript",
          json: "application/json",
          wasm: "application/wasm",
          map: "application/json",
        };
        res.setHeader(
          "Content-Type",
          mimeTypes[ext] || "application/octet-stream"
        );
        res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        res.end(content);
      });
    },
  };
}

/**
 * Proxy npm registry requests and add Cross-Origin-Resource-Policy header.
 * The nassun WASM client (used by VS Code's TypeScript extension for ATA)
 * fetches from registry.npmjs.org. Our COEP header blocks those responses
 * because npm doesn't set Cross-Origin-Resource-Policy. This proxy adds it.
 */
function npmRegistryProxy(): Plugin {
  return {
    name: "npm-registry-proxy",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/npm-registry/")) return next();
        const npmPath = url.slice("/npm-registry/".length);
        const proxyReq = httpsGet(
          `https://registry.npmjs.org/${npmPath}`,
          (proxyRes) => {
            // Forward all headers, add CORP for COEP compatibility
            const headers: Record<string, string | string[]> = {};
            for (const [k, v] of Object.entries(proxyRes.headers)) {
              if (v) headers[k] = v;
            }
            headers["cross-origin-resource-policy"] = "cross-origin";
            headers["access-control-allow-origin"] = "*";
            res.writeHead(proxyRes.statusCode ?? 200, headers);
            proxyRes.pipe(res);
          }
        );
        proxyReq.on("error", () => {
          res.writeHead(502, {
            "Content-Type": "application/json",
            "Cross-Origin-Resource-Policy": "cross-origin",
          });
          res.end(JSON.stringify({ error: "npm registry proxy error" }));
        });
        proxyReq.end();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    // COOP/COEP headers FIRST — must apply to ALL responses including extension workers
    {
      name: "cross-origin-isolation",
      configureServer(server) {
        server.middlewares.use((_req, res, next) => {
          res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
          next();
        });
      },
    },
    react(),
    tailwindcss(),
    npmRegistryProxy(),
    vsixPlugin(),
    vsixDevPlugin(),
    extensionFilePlugin(),
  ],
  assetsInclude: ["**/*.wasm"],
  server: {
    port: 3002,
    headers: {
      "Content-Security-Policy":
        "default-src * 'unsafe-inline' 'unsafe-eval' blob: data: extension-file:; connect-src * blob: data: extension-file:;",
    },
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    esbuildOptions: {
      plugins: [importMetaUrlPlugin],
    },
    include: ["vscode/localExtensionHost"],
  },
  resolve: {
    dedupe: ["monaco-editor"],
  },
  esbuild: {
    minifySyntax: false,
  },
});
