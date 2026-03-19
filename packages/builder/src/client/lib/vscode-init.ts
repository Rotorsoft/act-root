/**
 * VSCode Workbench initialization — full VS Code experience.
 *
 * Uses @codingame/monaco-vscode-workbench-service-override for the complete
 * workbench layout: file explorer, editor tabs, split views, and status bar.
 *
 * SharedArrayBuffer (via COOP/COEP headers) enables project-wide IntelliSense.
 */
import { LogLevel } from "@codingame/monaco-vscode-api";
import { registerExtension } from "@codingame/monaco-vscode-api/extensions";
import * as monaco from "@codingame/monaco-vscode-editor-api";
import getExplorerServiceOverride from "@codingame/monaco-vscode-explorer-service-override";
import {
  ExtensionHostKind,
  default as getExtensionServiceOverride,
} from "@codingame/monaco-vscode-extensions-service-override";
import {
  InMemoryFileSystemProvider,
  registerFileSystemOverlay,
  type IFileWriteOptions,
} from "@codingame/monaco-vscode-files-service-override";
import "@codingame/monaco-vscode-javascript-default-extension";
import getKeybindingsServiceOverride from "@codingame/monaco-vscode-keybindings-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getMarkersServiceOverride from "@codingame/monaco-vscode-markers-service-override";
import getSearchServiceOverride from "@codingame/monaco-vscode-search-service-override";
import getTextmateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import "@codingame/monaco-vscode-theme-defaults-default-extension";
import "@codingame/monaco-vscode-typescript-basics-default-extension";
import "@codingame/monaco-vscode-typescript-language-features-default-extension";
import getWorkbenchServiceOverride from "@codingame/monaco-vscode-workbench-service-override";
import {
  MonacoVscodeApiWrapper,
  type MonacoVscodeApiConfig,
} from "monaco-languageclient/vscodeApiWrapper";
import { configureDefaultWorkerFactory } from "monaco-languageclient/workerFactory";
import * as vscode from "vscode";

// Configure worker factory IMMEDIATELY at module load time — must be done before
// the workbench tries to create the extension host worker
configureDefaultWorkerFactory();

/**
 * Proxy npm registry requests through our server.
 * COEP (Cross-Origin-Embedder-Policy) blocks registry.npmjs.org responses
 * because npm doesn't set Cross-Origin-Resource-Policy. Our proxy adds it.
 */
function rewriteNpmUrl(url: string): string {
  if (url.includes("registry.npmjs.org")) {
    return url.replace(
      /https?:\/\/registry\.npmjs\.org\//,
      `${location.origin}/npm-registry/`
    );
  }
  return url;
}
const _originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = function (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  if (typeof input === "string") {
    return _originalFetch(rewriteNpmUrl(input), init);
  }
  if (input instanceof URL) {
    return _originalFetch(rewriteNpmUrl(input.toString()), init);
  }
  if (input instanceof Request) {
    const rewritten = rewriteNpmUrl(input.url);
    if (rewritten !== input.url) {
      return _originalFetch(new Request(rewritten, input), init);
    }
  }
  return _originalFetch(input, init);
};

/**
 * Patch Worker in the MAIN THREAD — the TS extension runs in the local extension
 * host (main thread) and calls new Worker('extension-file://...') directly.
 */
const OriginalWorker = globalThis.Worker;
globalThis.Worker = new Proxy(OriginalWorker, {
  construct(target, args: [string | URL, WorkerOptions?]): Worker {
    const url = args[0];
    const isExtFile =
      (typeof url === "string" && url.startsWith("extension-file://")) ||
      (url instanceof URL && url.protocol === "extension-file:");
    if (!isExtFile) return new target(url, args[1]);

    const httpUrl =
      typeof url === "string"
        ? `${location.origin}/extension-file/${url.slice("extension-file://".length)}`
        : `${location.origin}/extension-file/${url.host}${url.pathname}`;

    const bootstrap = `
      function rewriteUrl(url) {
        if (typeof url === 'string' && url.startsWith('extension-file://'))
          return '${location.origin}/extension-file/' + url.slice('extension-file://'.length);
        if (typeof url === 'string' && url.startsWith('file:///workspace/'))
          return '${location.origin}/workspace-fs/' + url.slice('file:///workspace/'.length);
        if (typeof url === 'string' && url.indexOf('registry.npmjs.org') !== -1)
          return url.replace(/https?:\\/\\/registry\\.npmjs\\.org\\//, '${location.origin}/npm-registry/');
        return url;
      }
      var nativeFetch = fetch.bind(self);
      self.fetch = function(input, init) {
        if (input instanceof Request) {
          var rewritten = rewriteUrl(input.url);
          if (rewritten !== input.url) return nativeFetch(new Request(rewritten, input), init);
          return nativeFetch(input, init);
        }
        return nativeFetch(rewriteUrl(String(input)), init);
      };
      var origXHROpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url) {
        var args = Array.prototype.slice.call(arguments);
        args[1] = rewriteUrl(String(url));
        return origXHROpen.apply(this, args);
      };
      var nativeImportScripts = importScripts.bind(self);
      self.importScripts = function() {
        return nativeImportScripts.apply(self, Array.from(arguments).map(rewriteUrl));
      };
      importScripts("${httpUrl}");
    `;
    const blob = new Blob([bootstrap], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    const worker = new target(blobUrl, args[1]);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
    return worker;
  },
});

const WORKSPACE = "/workspace";

const textEncoder = new TextEncoder();
const writeOpts: IFileWriteOptions = {
  atomic: false,
  unlock: false,
  create: true,
  overwrite: true,
};

const createdDirs = new Set<string>();

/** Ensure parent directories exist, then write file */
async function writeFile(
  fs: InMemoryFileSystemProvider,
  path: string,
  content: string
) {
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    const dir = "/" + parts.slice(0, i).join("/");
    if (createdDirs.has(dir)) continue;
    try {
      await fs.mkdir(vscode.Uri.file(dir));
    } catch {
      // already exists
    }
    createdDirs.add(dir);
  }
  await fs.writeFile(
    vscode.Uri.file(path),
    textEncoder.encode(content),
    writeOpts
  );
}

function createWorkspaceContent() {
  return JSON.stringify({ folders: [{ path: WORKSPACE }] }, null, 2);
}

let initPromise: Promise<{
  wrapper: MonacoVscodeApiWrapper;
  fs: InMemoryFileSystemProvider;
}> | null = null;

export function initVscodeWorkbench(htmlContainer: HTMLElement) {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // Set up filesystem and write ALL types BEFORE initializing services
    const fileSystemProvider = new InMemoryFileSystemProvider();
    await fileSystemProvider.mkdir(vscode.Uri.file(WORKSPACE));
    await fileSystemProvider.writeFile(
      vscode.Uri.file("/workspace.code-workspace"),
      textEncoder.encode(createWorkspaceContent()),
      writeOpts
    );

    // Write a fallback tsconfig — will be overwritten if project has its own
    await writeFile(
      fileSystemProvider,
      `${WORKSPACE}/tsconfig.json`,
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "node",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            jsx: "react-jsx",
            allowImportingTsExtensions: true,
            noEmit: true,
          },
          include: ["src/**/*", "packages/*/src/**/*", "libs/*/src/**/*"],
        },
        null,
        2
      )
    );
    registerFileSystemOverlay(1, fileSystemProvider);

    const vscodeApiConfig: MonacoVscodeApiConfig = {
      $type: "extended",
      viewsConfig: {
        $type: "WorkbenchService",
        htmlContainer,
      },
      logLevel: LogLevel.Error,
      advanced: {
        loadExtensionServices: false,
        enableExtHostWorker: true,
      },
      serviceOverrides: {
        ...getWorkbenchServiceOverride(),
        ...getExplorerServiceOverride(),
        ...getSearchServiceOverride(),
        ...getMarkersServiceOverride(),
        ...getLanguagesServiceOverride(),
        ...getKeybindingsServiceOverride(),
        ...getTextmateServiceOverride(),
        ...getExtensionServiceOverride({
          enableWorkerExtensionHost: true,
        }),
      },
      userConfiguration: {
        json: JSON.stringify({
          "workbench.colorTheme": "Default Dark Modern",
          "workbench.sideBar.location": "left",
          "workbench.statusBar.visible": false,
          "workbench.activityBar.location": "default",
          "workbench.layoutControl.enabled": false,
          "window.titleBarStyle": "native",
          "window.commandCenter": false,
          "window.menuBarVisibility": "hidden",
          "editor.wordBasedSuggestions": "off",
          "editor.minimap.enabled": false,
          "editor.renderLineHighlight": "none",
          "explorer.compactFolders": true,
          "explorer.autoReveal": true,
          "explorer.openEditors.visible": 0,
          "typescript.tsserver.web.projectWideIntellisense.enabled": true,
          "typescript.tsserver.web.projectWideIntellisense.suppressSemanticErrors": false,
          "typescript.disableAutomaticTypeAcquisition": false,
        }),
      },
      workspaceConfig: {
        enableWorkspaceTrust: true,
        workspaceProvider: {
          trusted: true,
          open: () => Promise.resolve(false),
          workspace: {
            workspaceUri: vscode.Uri.file("/workspace.code-workspace"),
          },
        },
      },
      monacoWorkerFactory: configureDefaultWorkerFactory,
    };

    const wrapper = new MonacoVscodeApiWrapper(vscodeApiConfig);
    await wrapper.start();

    // Register as default API provider — required for extensions to work with the workbench
    await registerExtension(
      {
        name: "act-builder",
        publisher: "rotorsoft",
        version: "1.0.0",
        engines: { vscode: "*" },
      },
      ExtensionHostKind.LocalProcess
    ).setAsDefaultApi();

    // Open the explorer sidebar by default
    try {
      await vscode.commands.executeCommand("workbench.view.explorer");
    } catch {
      // command may not be available yet
    }

    return { wrapper, fs: fileSystemProvider };
  })();

  return initPromise;
}

/** Strip pnpm workspace protocol from package.json dependencies */
function sanitizeContent(path: string, content: string): string {
  if (path.endsWith("package.json")) {
    return content.replace(/"workspace:[*^~]"/g, '"*"');
  }
  return content;
}

/** Write a user file to the workspace. Auto-creates node_modules entries for workspace packages. */
export async function writeWorkspaceFile(
  fs: InMemoryFileSystemProvider,
  path: string,
  content: string
) {
  const sanitized = sanitizeContent(path, content);
  await writeFile(fs, `${WORKSPACE}/${path}`, sanitized);

  // Auto-create node_modules entry for any workspace sub-package
  // Matches: packages/*/package.json, libs/*/package.json, or any nested dir
  if (path !== "package.json" && path.endsWith("/package.json")) {
    try {
      const pkg = JSON.parse(sanitized) as { name?: string };
      if (pkg.name) {
        const pkgDir = path.replace(/\/package\.json$/, "");
        const nmSegments = `node_modules/${pkg.name}`.split("/").length;
        const rel = "../".repeat(nmSegments) + pkgDir;
        await writeFile(
          fs,
          `${WORKSPACE}/node_modules/${pkg.name}/package.json`,
          JSON.stringify({
            name: pkg.name,
            version: "0.0.0",
            types: `${rel}/src/index.ts`,
          })
        );
      }
    } catch {
      // skip malformed package.json
    }
  }
}

/** Open a file in the workbench editor */
export async function openFileInEditor(path: string, preview = false) {
  const uri = vscode.Uri.file(`${WORKSPACE}/${path}`);
  await vscode.window.showTextDocument(uri, {
    preview,
    preserveFocus: false,
  });
}

/** Close all open editors */
export async function closeAllEditors() {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

/** Get all Monaco editor markers (errors) for workspace files */
export function getWorkspaceErrors(): string[] {
  const markers = monaco.editor.getModelMarkers({});
  const wsPrefix = `file://${WORKSPACE}/`;
  return markers
    .filter(
      (m) =>
        Number(m.severity) >= 8 && m.resource.toString().startsWith(wsPrefix)
    )
    .map((m) => {
      const path = m.resource.toString().slice(wsPrefix.length);
      return `${path}:${m.startLineNumber}: ${m.message}`;
    });
}

/** Reveal and select a word in the active editor */
export function revealWord(line: number, col: number, len: number) {
  const editor = monaco.editor.getEditors()[0];
  if (editor) {
    editor.revealLineInCenter(line);
    editor.setSelection({
      startLineNumber: line,
      startColumn: col,
      endLineNumber: line,
      endColumn: col + len,
    });
    editor.focus();
  }
}

/** Trigger workbench layout recalculation (e.g. after container becomes visible) */
export function triggerResize() {
  window.dispatchEvent(new Event("resize"));
}

export { monaco, WORKSPACE };
