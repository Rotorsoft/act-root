/**
 * Evaluates Act builder code by executing it with mock builders,
 * then extracts the domain model for the diagram.
 */
import { transform } from "sucrase";
import type {
  ActNode,
  DomainModel,
  EventNode,
  FileTab,
  ReactionNode,
} from "../types/index.js";
import { MODULES } from "./mock-builders.js";
import { topoSort } from "./sort.js";

// ─── Code transpilation ─────────────────────────────────────────────

function transpile(code: string): string {
  try {
    const safe = code.replace(/\bimport\.meta\.\w+/g, "'__import_meta__'");
    const { code: js } = transform(safe, {
      transforms: ["typescript", "imports"],
    });
    return js;
  } catch {
    return code;
  }
}

// ─── Per-file module execution ──────────────────────────────────────

function execute(files: FileTab[]): {
  states: any[];
  slices: any[];
  projections: any[];
  acts: any[];
  error?: string;
} {
  const result = {
    states: [] as any[],
    slices: [] as any[],
    projections: [] as any[],
    acts: [] as any[],
    error: undefined as string | undefined,
  };

  try {
    const __built__: Record<string, any[]> = {
      states: [],
      slices: [],
      projections: [],
      acts: [],
    };

    function wrapBuild(builder: any, type: string) {
      const orig = builder.build;
      builder.build = function (...args: any[]) {
        const r = orig.apply(builder, args);
        __built__[type + "s"].push(r);
        return r;
      };
      return builder;
    }

    const actModule = { ...MODULES["@rotorsoft/act"] };
    const origState = actModule.state as any;
    const origSlice = actModule.slice as any;
    const origProjection = actModule.projection as any;
    const origAct = actModule.act as any;
    actModule.state = (entry: any) => wrapBuild(origState(entry), "state");
    actModule.slice = () => wrapBuild(origSlice(), "slice");
    actModule.projection = (target: any) =>
      wrapBuild(origProjection(target), "projection");
    actModule.act = () => wrapBuild(origAct(), "act");

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
        if (pkgName) {
          return (
            fileExports.get(`packages/${pkgName}/src/index`) ??
            fileExports.get(`${pkgName}/src/index`) ??
            fileExports.get(`${pkgName}/index`) ??
            fileExports.get(pkgName) ??
            {}
          );
        }
      }

      return {};
    };

    // Evaluate each file in topo order, each in its own scope
    const sorted = topoSort(
      files.filter((f) => f.path.endsWith(".ts") || f.path.endsWith(".tsx"))
    );

    for (const file of sorted) {
      const js = transpile(file.content);
      const key = strip(file.path);
      const fileExp: Record<string, any> = {};
      fileExports.set(key, fileExp);

      // Capture slice variable names from CJS output
      const sliceCountBefore = __built__.slices.length;
      const sliceVarNames: string[] = [];
      const sliceRe = /(?:var|let|const)\s+(\w+)\s*=\s*\w+\.slice\b/g;
      let sm;
      while ((sm = sliceRe.exec(js)) !== null) sliceVarNames.push(sm[1]);

      const fileRequire = (mod: string) => resolveModule(mod, key);

      try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fn = new Function(
          "require",
          "exports",
          "module",
          "__filename",
          "__dirname",
          `
          "use strict";
          var process = { env: {}, cwd: function() { return "/"; } };
          var Buffer = { from: function() { return ""; } };
          ${js}
        `
        );
        const result = fn(
          fileRequire,
          fileExp,
          { exports: fileExp },
          file.path,
          "."
        );
        // Swallow async errors from top-level calls (e.g. async main())
        if (
          result &&
          typeof result === "object" &&
          typeof result.catch === "function"
        ) {
          result.catch(() => {});
        }
      } catch {
        // Skip files that fail (infrastructure code)
      }

      // Tag newly built slices with their variable names
      for (let i = sliceCountBefore; i < __built__.slices.length; i++) {
        const varIdx = i - sliceCountBefore;
        if (varIdx < sliceVarNames.length) {
          __built__.slices[i]._varName = sliceVarNames[varIdx];
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
  const { states, slices, projections, acts, error } = execute(files);

  const model: DomainModel = {
    states: [],
    slices: [],
    projections: [],
    reactions: [],
  };

  if (error) return { model, error };

  const statesInSlices = new Set<string>();

  for (const s of slices) {
    if (s._tag !== "Slice") continue;

    const sliceStates: any[] = [];
    const sliceStateNames: string[] = [];

    for (const st of (s.states as Array<{ _tag: string; name: string }>) ||
      []) {
      if (st._tag === "State") {
        sliceStates.push(st);
        sliceStateNames.push(st.name);
        statesInSlices.add(st.name);
        addState(model, st);
      }
    }

    const eventOwner = new Map<string, string>();
    for (const st of sliceStates) {
      for (const evName of Object.keys(
        (st.events as Record<string, unknown>) || {}
      )) {
        eventOwner.set(evName, st.name as string);
      }
    }

    const sliceReactions: ReactionNode[] = [];
    for (const r of (s.reactions as ReactionNode[]) || []) {
      const sourceState = eventOwner.get(r.event);
      const dispatches: string[] = [];
      for (const st of sliceStates) {
        if (st.name !== sourceState) {
          for (const actionName of Object.keys(
            (st.actions as Record<string, unknown>) || {}
          )) {
            if (!actionName.startsWith("__emits_")) dispatches.push(actionName);
          }
        }
      }
      sliceReactions.push({ ...r, dispatches });
    }

    const projNames: string[] = [];
    for (const p of (s.projections as Array<{
      _tag: string;
      target?: string;
    }>) || []) {
      if (p._tag === "Projection") projNames.push(p.target || "projection");
    }

    model.slices.push({
      name: (s._varName as string) || sliceStateNames.join(", "),
      states: sliceStateNames,
      stateVars: sliceStateNames,
      projections: projNames,
      reactions: sliceReactions,
    });
  }

  for (const p of projections) {
    if (p._tag !== "Projection") continue;
    model.projections.push({
      name: (p.target as string) || "projection",
      varName: (p.target as string) || "projection",
      handles: (p.handles as string[]) || [],
    });
  }

  for (const s of states) {
    if (s._tag === "State" && !statesInSlices.has(s.name as string)) {
      addState(model, s);
    }
  }

  for (const a of acts) {
    if (a._tag !== "Act") continue;
    for (const st of (a.states as Array<{ _tag: string; name: string }>) ||
      []) {
      if (st._tag === "State" && !statesInSlices.has(st.name))
        addState(model, st);
    }
    model.orchestrator = {
      slices: model.slices.map((s) => s.name),
      projections: model.projections.map((p) => p.name),
      states: model.states.map((s) => s.name),
    } as ActNode;
    for (const r of (a.reactions as ReactionNode[]) || []) {
      model.reactions.push(r);
    }
  }

  return { model };
}

function addState(model: DomainModel, st: any): void {
  if (model.states.some((s) => s.name === st.name)) return;

  const events: EventNode[] = [];
  for (const eventName of Object.keys(
    (st.events || {}) as Record<string, unknown>
  )) {
    events.push({
      name: eventName,
      hasCustomPatch: st.patches?.has(eventName) ?? false,
    });
  }

  const actions: any[] = [];
  for (const actionName of Object.keys(
    (st.actions || {}) as Record<string, unknown>
  )) {
    if (actionName.startsWith("__emits_")) continue;
    const emits: string[] = st.actions[`__emits_${actionName}`] || [];
    const invariants = (
      (st.given?.[actionName] as Array<{ description?: string }>) || []
    ).map((inv) => inv.description || "");
    actions.push({ name: actionName, emits, invariants });
  }

  model.states.push({ name: st.name, varName: st.name, events, actions });
}
