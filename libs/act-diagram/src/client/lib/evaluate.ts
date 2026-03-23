/**
 * Evaluates Act builder code by executing it with mock builders,
 * then extracts the domain model for the diagram.
 */
import { transform } from "sucrase";
import type { DomainModel, FileTab } from "../types/index.js";
import { buildModel, type ExecuteResult } from "./build-model.js";
import { MODULES, unknownModuleProxy } from "./mock-builders.js";
import { topoSort } from "./sort.js";

// ─── Code transpilation ─────────────────────────────────────────────

function transpile(code: string): string {
  try {
    const safe = code.replace(/\bimport\.meta\.\w+/g, "'__import_meta__'");
    const { code: js } = transform(safe, {
      transforms: ["typescript", "imports"],
    });
    // Strip top-level runtime invocations — we only need builder definitions.
    return js.replace(
      /^(?:void\s+|await\s+)?(?:main|run|start|bootstrap|seed)\s*\([^)]*\)(?:\s*\.catch\([^)]*\))?;?\s*$/gm,
      "/* stripped runtime call */"
    );
  } catch {
    return code;
  }
}

// ─── Per-file module execution ──────────────────────────────────────

function execute(files: FileTab[]): ExecuteResult {
  const result = {
    states: [] as any[],
    slices: [] as any[],
    projections: [] as any[],
    acts: [] as any[],
    error: undefined as string | undefined,
    fileErrors: new Map<string, string>(),
  };

  try {
    const __built__: Record<string, any[]> = {
      states: [],
      slices: [],
      projections: [],
      acts: [],
    };

    let _currentFile = "";
    const capture = (type: string) => (info: any) => {
      info._sourceFile = _currentFile;
      __built__[type + "s"].push(info);
    };

    const actModule = { ...MODULES["@rotorsoft/act"] };
    actModule.state = (entry: any) =>
      (MODULES["@rotorsoft/act"].state as any)(entry, capture("state"));
    actModule.slice = () =>
      (MODULES["@rotorsoft/act"].slice as any)(capture("slice"));
    actModule.projection = (target: any) =>
      (MODULES["@rotorsoft/act"].projection as any)(
        target,
        capture("projection")
      );
    actModule.act = () =>
      (MODULES["@rotorsoft/act"].act as any)(capture("act"));

    const pkgModules: Record<string, any> = {
      ...MODULES,
      "@rotorsoft/act": actModule,
    };

    // Per-file exports: each file gets its own exports object
    const fileExports = new Map<string, Record<string, any>>();

    const strip = (p: string) => p.replace(/\.tsx?$/, "");

    const resolveModule = (
      mod: string,
      fromPath: string
    ): Record<string, any> => {
      if (pkgModules[mod]) return pkgModules[mod];

      if (mod.startsWith(".")) {
        const dir = fromPath.includes("/")
          ? fromPath.slice(0, fromPath.lastIndexOf("/"))
          : "";
        const parts = (dir ? dir + "/" + mod : mod).split("/");
        const resolved: string[] = [];
        for (const p of parts) {
          if (p === "." || p === "") continue;
          if (p === "..") resolved.pop();
          else resolved.push(p);
        }
        const rp = resolved.join("/").replace(/\.js$/, "").replace(/\.ts$/, "");
        return fileExports.get(rp) ?? fileExports.get(rp + "/index") ?? {};
      }

      if (mod.startsWith("@") && !mod.startsWith("@rotorsoft/")) {
        const pkgName = mod.split("/")[1];
        const subPath = mod.split("/").slice(2).join("/");
        if (pkgName) {
          const suffix = subPath
            ? `/${subPath.replace(/\.js$/, "")}`
            : "/src/index";
          return (
            fileExports.get(`packages/${pkgName}${suffix}`) ??
            fileExports.get(`${pkgName}${suffix}`) ??
            fileExports.get(`packages/${pkgName}/src/index`) ??
            fileExports.get(`${pkgName}/src/index`) ??
            fileExports.get(`${pkgName}/index`) ??
            fileExports.get(pkgName) ??
            unknownModuleProxy()
          );
        }
      }

      return unknownModuleProxy();
    };

    // Evaluate each file in topo order, each in its own scope
    const sorted = topoSort(
      files.filter(
        (f) =>
          f.path.endsWith(".ts") &&
          !f.path.endsWith(".d.ts") &&
          !f.path.endsWith(".tsx") &&
          !f.path.endsWith(".spec.ts") &&
          !f.path.endsWith(".test.ts") &&
          !f.path.includes("node_modules/") &&
          !f.path.includes("__tests__/") &&
          !f.path.includes("/test/") &&
          !f.path.startsWith("test/")
      )
    );

    for (const file of sorted) {
      _currentFile = file.path;
      const js = transpile(file.content);
      const key = strip(file.path);
      const fileExp: Record<string, any> = {};
      fileExports.set(key, fileExp);

      // Pre-scan: capture slice variable names before eval
      const sliceNamesInAct: string[] = [];
      const wsRe = /\.withSlice\(\s*(?:\w+\.)*(\w+)\s*\)/g;
      let wsm;
      while ((wsm = wsRe.exec(js)) !== null) {
        if (!sliceNamesInAct.includes(wsm[1])) sliceNamesInAct.push(wsm[1]);
      }

      const fileRequire = (mod: string) => resolveModule(mod, key);

      try {
        // Strip __dirname/__filename declarations that would conflict with our injected vars
        const cleanJs = js
          .replace(/\bconst\s+__dirname\b/g, "var __dirname")
          .replace(/\bconst\s+__filename\b/g, "var __filename");
        // Security: new Function() is intentional — this executes the user's own
        // local project files (selected via folder picker or passed as props) to
        // extract Act builder structure. Same trust model as VS Code, Jupyter, or
        // any tool that runs user code. No HTTP input or untrusted data is evaluated.
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fn = new Function(
          "require",
          "exports",
          "module",
          `
          "use strict";
          var __filename = "${file.path}";
          var __dirname = ".";
          var process = { env: {}, cwd: function() { return "/"; }, exit: function() {}, on: function() {}, off: function() {} };
          var Buffer = { from: function() { return ""; } };
          var console = { log: function() {}, error: function() {}, warn: function() {}, info: function() {}, debug: function() {} };
          ${cleanJs}
        `
        );
        fn(fileRequire, fileExp, { exports: fileExp });
      } catch (evalErr: unknown) {
        // Just record the error — Step 3 creates placeholders for missing slices
        const errMsg =
          evalErr instanceof Error ? evalErr.message : String(evalErr);
        result.fileErrors.set(file.path, errMsg);
      }

      // Tag slices with names from .withSlice(VAR) — only for acts built in THIS file
      if (sliceNamesInAct.length > 0) {
        for (const actObj of __built__.acts) {
          if ((actObj._sourceFile as string) !== file.path) continue;
          const actSlices = actObj.slices as any[];
          for (
            let ai = 0;
            ai < Math.min(sliceNamesInAct.length, actSlices.length);
            ai++
          ) {
            if (actSlices[ai]) {
              actSlices[ai]._varName = sliceNamesInAct[ai];
            }
          }
        }
      }
    }

    result.states = __built__.states;
    result.slices = __built__.slices;
    result.projections = __built__.projections;
    result.acts = __built__.acts;
  } catch (e: unknown) {
    result.error = e instanceof Error ? e.message : String(e);
  }

  return result;
}

// ─── Model extraction ───────────────────────────────────────────────

export function extractModel(files: FileTab[]): {
  model: DomainModel;
  error?: string;
} {
  const result = execute(files);

  // Scan source for expected slice declarations (inventory)
  const expectedSlices = new Map<string, string>();
  for (const file of files) {
    if (
      !file.path.endsWith(".ts") ||
      file.path.endsWith(".d.ts") ||
      file.path.endsWith(".spec.ts") ||
      file.path.endsWith(".test.ts") ||
      file.path.includes("node_modules/")
    )
      continue;
    for (const m of file.content.matchAll(
      /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*slice\s*\(\s*\)/g
    )) {
      expectedSlices.set(m[1], file.path);
    }
  }

  return buildModel(result, files, expectedSlices);
}
