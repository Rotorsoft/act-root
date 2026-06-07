/**
 * Evaluates Act builder code by executing it with mock builders,
 * then extracts the domain model for the diagram.
 */
import { transform } from "sucrase";
import type { DomainModel, FileTab } from "../types/index.js";
import { build_model, type ExecuteResult } from "./build-model.js";
import { MODULES, unknown_module_proxy } from "./mock-builders.js";
import { topo_sort } from "./sort.js";

/** Replace non-executable content with same-length whitespace (preserving offsets).
 *  `level: "full"` strips comments + strings + template literals (for scanning).
 *  `level: "nav"` strips comments + template literals only (for navigation). */
export const strip_non_code = (src: string, level: "full" | "nav" = "full") => {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  let result = src
    .replace(/\/\/[^\n]*/g, blank) // line comments
    .replace(/\/\*[\s\S]*?\*\//g, blank) // block comments
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, blank); // template literals
  if (level === "full") {
    result = result
      .replace(/"(?:\\[\s\S]|[^"\\])*"/g, blank) // double-quoted strings
      .replace(/'(?:\\[\s\S]|[^'\\])*'/g, blank); // single-quoted strings
  }
  return result;
};

/** Source file filter — excludes tests, declarations, and non-TS files */
const is_source_file = (f: FileTab) =>
  f.path.endsWith(".ts") &&
  !f.path.endsWith(".d.ts") &&
  !f.path.endsWith(".tsx") &&
  !f.path.endsWith(".spec.ts") &&
  !f.path.endsWith(".test.ts") &&
  !f.path.includes("node_modules/") &&
  !f.path.includes("__tests__/") &&
  !f.path.includes("/test/") &&
  !f.path.startsWith("test/");

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

function execute(
  files: FileTab[]
): ExecuteResult & { expected_slices: Map<string, string> } {
  const result = {
    states: [] as any[],
    slices: [] as any[],
    projections: [] as any[],
    acts: [] as any[],
    error: undefined as string | undefined,
    file_errors: new Map<string, string>(),
    expected_slices: new Map<string, string>(),
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

    const act_module = { ...MODULES["@rotorsoft/act"] };
    act_module.state = (entry: any) =>
      (MODULES["@rotorsoft/act"].state as any)(entry, capture("state"));
    act_module.slice = () =>
      (MODULES["@rotorsoft/act"].slice as any)(capture("slice"));
    act_module.projection = (target: any) =>
      (MODULES["@rotorsoft/act"].projection as any)(
        target,
        capture("projection")
      );
    act_module.act = () =>
      (MODULES["@rotorsoft/act"].act as any)(capture("act"));

    const pkg_modules: Record<string, any> = {
      ...MODULES,
      "@rotorsoft/act": act_module,
    };

    // Per-file exports: each file gets its own exports object
    const file_exports = new Map<string, Record<string, any>>();

    const strip = (p: string) => p.replace(/\.tsx?$/, "");

    const resolve_module = (
      mod: string,
      from_path: string
    ): Record<string, any> => {
      if (pkg_modules[mod]) return pkg_modules[mod];

      if (mod.startsWith(".")) {
        const dir = from_path.includes("/")
          ? from_path.slice(0, from_path.lastIndexOf("/"))
          : "";
        const parts = (dir ? dir + "/" + mod : mod).split("/");
        const resolved: string[] = [];
        for (const p of parts) {
          if (p === "." || p === "") continue;
          if (p === "..") resolved.pop();
          else resolved.push(p);
        }
        const rp = resolved.join("/").replace(/\.js$/, "").replace(/\.ts$/, "");
        return file_exports.get(rp) ?? file_exports.get(rp + "/index") ?? {};
      }

      if (mod.startsWith("@") && !mod.startsWith("@rotorsoft/")) {
        const pkg_name = mod.split("/")[1];
        const sub_path = mod.split("/").slice(2).join("/");
        if (pkg_name) {
          const suffix = sub_path
            ? `/${sub_path.replace(/\.js$/, "")}`
            : "/src/index";
          return (
            file_exports.get(`packages/${pkg_name}${suffix}`) ??
            file_exports.get(`${pkg_name}${suffix}`) ??
            file_exports.get(`packages/${pkg_name}/src/index`) ??
            file_exports.get(`${pkg_name}/src/index`) ??
            file_exports.get(`${pkg_name}/index`) ??
            file_exports.get(pkg_name) ??
            unknown_module_proxy()
          );
        }
      }

      return unknown_module_proxy();
    };

    // Evaluate each file in topo order, each in its own scope
    const sorted = topo_sort(files.filter(is_source_file));

    for (const file of sorted) {
      _currentFile = file.path;
      const js = transpile(file.content);
      const key = strip(file.path);
      const fileExp: Record<string, any> = {};
      file_exports.set(key, fileExp);

      // Pre-scan: capture slice variable names before eval
      const slice_names_in_act: string[] = [];
      const ws_re = /\.withSlice\(\s*(?:\w+\.)*(\w+)\s*\)/g;
      let wsm: RegExpExecArray | null;
      const code_only = strip_non_code(js);
      while ((wsm = ws_re.exec(code_only)) !== null) {
        if (!slice_names_in_act.includes(wsm[1]))
          slice_names_in_act.push(wsm[1]);
      }

      // Inventory: detect slice declarations in executable code
      // sucrase may emit slice() or slice.call(void 0, )
      for (const m of code_only.matchAll(
        /(?:exports\.)?(\w+)\s*=\s*(?:\w+\.)?slice(?:\s*\(\s*\)|\.call\(void 0,\s*\))/g
      )) {
        result.expected_slices.set(m[1], file.path);
      }

      const file_require = Object.assign(
        (mod: string) => resolve_module(mod, key),
        { resolve: (mod: string) => mod, cache: {}, main: undefined }
      );

      try {
        // Strip __dirname/__filename declarations that would conflict with our injected vars
        const clean_js = js
          .replace(/\bconst\s+__dirname\b/g, "var __dirname")
          .replace(/\bconst\s+__filename\b/g, "var __filename");
        // Security: new Function() is intentional — this executes the user's own
        // local project files (selected via folder picker or passed as props) to
        // extract Act builder structure. Same trust model as VS Code, Jupyter, or
        // any tool that runs user code. No HTTP input or untrusted data is evaluated.
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fn = new Function(
          // lgtm[js/code-injection]
          "require",
          "exports",
          "module",
          `
          "use strict";
          var __filename = ${JSON.stringify(file.path)};
          var __dirname = ".";
          var process = { env: {}, cwd: function() { return "/"; }, exit: function() {}, on: function() {}, off: function() {} };
          var Buffer = { from: function() { return ""; } };
          var console = { log: function() {}, error: function() {}, warn: function() {}, info: function() {}, debug: function() {} };
          ${clean_js}
        `
        );
        fn(file_require, fileExp, { exports: fileExp });
      } catch (evalErr: unknown) {
        // Just record the error — Step 3 creates placeholders for missing slices
        const errMsg =
          evalErr instanceof Error ? evalErr.message : String(evalErr);
        result.file_errors.set(file.path, errMsg);
      }

      // Tag slices with names from .withSlice(VAR) — only for acts built in THIS file
      if (slice_names_in_act.length > 0) {
        for (const act_obj of __built__.acts) {
          if ((act_obj._sourceFile as string) !== file.path) continue;
          const act_slices = act_obj.slices as any[];
          for (
            let ai = 0;
            ai < Math.min(slice_names_in_act.length, act_slices.length);
            ai++
          ) {
            if (act_slices[ai]) {
              act_slices[ai]._varName = slice_names_in_act[ai];
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

export function extract_model(files: FileTab[]): {
  model: DomainModel;
  error?: string;
} {
  const result = execute(files);
  return build_model(result, files, result.expected_slices);
}
