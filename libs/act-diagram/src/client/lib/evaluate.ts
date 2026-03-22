/**
 * Evaluates Act builder code by executing it with mock builders,
 * then extracts the domain model for the diagram.
 */
import { transform } from "sucrase";
import type {
  ActionNode,
  ActNode,
  DomainModel,
  EventNode,
  FileTab,
  ReactionNode,
} from "../types/index.js";
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
        /* v8 ignore next -- fallback for unresolvable relative imports */
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

      // Capture slice names from .withSlice(VAR) calls in act() chains
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
      } catch {
        // Eval failed — fall through to regex extraction
        const fallback = extractFromSource(file.content);
        for (const s of fallback.states) __built__.states.push(s);
        for (const s of fallback.slices) __built__.slices.push(s);
        for (const p of fallback.projections) __built__.projections.push(p);
        for (const a of fallback.acts) __built__.acts.push(a);
      }

      // Tag slices with names from .withSlice(VAR) — only for acts built in THIS file
      if (sliceNamesInAct.length > 0) {
        for (const actObj of __built__.acts) {
          if ((actObj._sourceFile as string) !== file.path) continue;
          /* v8 ignore next -- actObj.slices always populated by mockAct */
          const actSlices = (actObj.slices as any[]) || [];
          for (
            let ai = 0;
            ai < Math.min(sliceNamesInAct.length, actSlices.length);
            ai++
          ) {
            actSlices[ai]._varName = sliceNamesInAct[ai];
          }
        }
      }
    }

    result.states = __built__.states;
    result.slices = __built__.slices;
    result.projections = __built__.projections;
    result.acts = __built__.acts;
  } catch (e: unknown) {
    /* v8 ignore next -- defensive: execute() setup failure */
    result.error = e instanceof Error ? e.message : String(e);
  }

  return result;
}

// ─── Regex fallback extraction ──────────────────────────────────────

/**
 * Extracts domain model structure from raw source code using regex patterns.
 * This is a fallback for files that fail mock evaluation — it captures the
 * essential builder structure without executing the code.
 */
function extractFromSource(content: string): {
  states: any[];
  slices: any[];
  projections: any[];
  acts: any[];
} {
  const states: any[] = [];
  const slices: any[] = [];
  const projections: any[] = [];
  const acts: any[] = [];

  // ── State extraction ────────────────────────────────────────────
  const stateNameRe = /\bstate\(\s*\{\s*(\w+)\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = stateNameRe.exec(content)) !== null) {
    const stateName = m[1];
    const chainStart = m.index;
    const chain = content.slice(chainStart);

    // Extract events from .emits({ Event1: schema, Event2: schema })
    const events: Record<string, any> = {};
    const emitsRe = /\.emits\(\s*\{([^}]*)\}/;
    const emitsMatch = emitsRe.exec(chain);
    if (emitsMatch) {
      const emitsBody = emitsMatch[1];
      const keyRe = /(\w+)\s*(?:[:,}])/g;
      let km;
      while ((km = keyRe.exec(emitsBody)) !== null) {
        events[km[1]] = true;
      }
    }

    // Extract patches from .patch({ EventName: ... })
    const patches = new Set<string>();
    const patchRe = /\.patch\(\s*\{([^}]*)\}/;
    const patchMatch = patchRe.exec(chain);
    if (patchMatch) {
      const patchBody = patchMatch[1];
      const keyRe = /(\w+)\s*(?:[:,}])/g;
      let km;
      while ((km = keyRe.exec(patchBody)) !== null) {
        patches.add(km[1]);
      }
    }

    // Extract actions from .on({ ActionName: schema })
    const actions: Record<string, any> = {};
    const given: Record<string, any[]> = {};
    const onRe = /\.on\(\s*\{\s*(\w+)\s*(?:[:,}])/g;
    let onMatch;
    while ((onMatch = onRe.exec(chain)) !== null) {
      const actionName = onMatch[1];
      actions[actionName] = true;

      const afterOn = chain.slice(onMatch.index + onMatch[0].length);

      // Check for .given([...]) before .emit()
      const givenRe = /\.given\(\s*\[([^\]]*)\]/;
      const givenMatch = givenRe.exec(afterOn.slice(0, 500));
      if (givenMatch) {
        const givenBody = givenMatch[1];
        const descRe = /description\s*:\s*["'`]([^"'`]*)["'`]/g;
        let dm;
        const invariants: { description: string }[] = [];
        while ((dm = descRe.exec(givenBody)) !== null) {
          invariants.push({ description: dm[1] });
        }
        if (invariants.length > 0) given[actionName] = invariants;
      }

      // Look for .emit("EventName") — string passthrough
      const emitStrRe = /\.emit\(\s*["'`](\w+)["'`]\s*\)/;
      const emitStrMatch = emitStrRe.exec(afterOn.slice(0, 500));
      if (emitStrMatch) {
        actions[`__emits_${actionName}`] = [emitStrMatch[1]];
      } else {
        // Try to find event names in handler body (arrow function)
        const emitFnRe = /\.emit\(\s*(?:\([^)]*\)\s*=>|function)/;
        const emitFnMatch = emitFnRe.exec(afterOn.slice(0, 500));
        if (emitFnMatch) {
          const handlerStart = emitFnMatch.index;
          const handlerBody = afterOn.slice(handlerStart, handlerStart + 500);
          const emitNames: string[] = [];
          for (const evName of Object.keys(events)) {
            if (
              handlerBody.includes(`"${evName}"`) ||
              handlerBody.includes(`'${evName}'`) ||
              handlerBody.includes(`\`${evName}\``)
            ) {
              emitNames.push(evName);
            }
          }
          if (emitNames.length > 0)
            actions[`__emits_${actionName}`] = emitNames;
        }
      }
    }

    if (stateName) {
      states.push({
        _tag: "State" as const,
        name: stateName,
        events,
        actions,
        given,
        patches,
      });
    }
  }

  // ── Slice extraction ────────────────────────────────────────────
  const sliceRe = /\bslice\(\s*\)/g;
  while ((m = sliceRe.exec(content)) !== null) {
    const chain = content.slice(m.index);
    const sliceStates: string[] = [];
    const sliceReactions: any[] = [];
    const sliceProjections: string[] = [];

    const wsRe = /\.withState\(\s*(\w+)\s*\)/g;
    let wsm;
    while ((wsm = wsRe.exec(chain)) !== null) {
      sliceStates.push(wsm[1]);
    }

    const wpRe = /\.withProjection\(\s*(\w+)\s*\)/g;
    let wpm;
    while ((wpm = wpRe.exec(chain)) !== null) {
      sliceProjections.push(wpm[1]);
    }

    const onDoRe =
      /\.on\(\s*["'`](\w+)["'`]\s*\)\s*\.do\(\s*(?:async\s+)?(?:function\s+(\w+)|(?:\w+\.)?(\w+))?/g;
    let odm;
    while ((odm = onDoRe.exec(chain)) !== null) {
      sliceReactions.push({
        event: odm[1],
        /* v8 ignore next -- regex always captures odm[2] or odm[3] */
        handlerName: odm[2] || odm[3] || `on ${odm[1]}`,
        dispatches: [],
        isVoid: false,
      });
    }

    slices.push({
      _tag: "Slice" as const,
      states: sliceStates.map((n) => ({ _tag: "State", name: n })),
      projections: sliceProjections.map((n) => ({
        _tag: "Projection",
        target: n,
      })),
      reactions: sliceReactions,
    });
  }

  // ── Projection extraction ───────────────────────────────────────
  const projRe = /\bprojection\(\s*["'`](\w+)["'`]\s*\)/g;
  while ((m = projRe.exec(content)) !== null) {
    const projName = m[1];
    const chain = content.slice(m.index);
    const handles: string[] = [];

    const ponRe = /\.on\(\s*\{\s*(\w+)\s*(?:[:,}])/g;
    let pm;
    while ((pm = ponRe.exec(chain)) !== null) {
      handles.push(pm[1]);
    }

    projections.push({
      _tag: "Projection" as const,
      target: projName,
      handles,
    });
  }

  return { states, slices, projections, acts };
}

// ─── Model extraction ───────────────────────────────────────────────

export function extractModel(files: FileTab[]): {
  model: DomainModel;
  error?: string;
} {
  const result = execute(files);
  const error = result.error;
  const states = result.states.filter((s: any) => s && s._tag);
  const slices = result.slices.filter((s: any) => s && s._tag);
  const projections = result.projections.filter((p: any) => p && p._tag);
  const acts = result.acts.filter((a: any) => a && a._tag);

  // Fix up reaction handler names that fell back to "on EventName" —
  // scan source for .on("event").do(module.handler) to recover real names
  const fixupReactions = (reactions: ReactionNode[], sourceFile?: string) => {
    /* v8 ignore next -- resilience path for proxy handlers */
    const fallbacks = reactions.filter((r) => r.handlerName.startsWith("on "));
    /* v8 ignore next */ if (fallbacks.length === 0) return;
    /* v8 ignore next 3 */
    const src = sourceFile
      ? files.find((f) => f.path === sourceFile)?.content
      : files.map((f) => f.content).join("\n");
    /* v8 ignore next */ if (!src) return;
    const doRe =
      /\.on\(\s*["'`](\w+)["'`]\s*\)\s*\.do\(\s*(?:async\s+)?(?:function\s+(\w+)|(?:\w+\.)?(\w+))?/g;
    let dm;
    /* v8 ignore next 8 */
    while ((dm = doRe.exec(src)) !== null) {
      const eventName = dm[1];
      const handlerName = dm[2] || dm[3];
      if (!handlerName) continue;
      const r = fallbacks.find(
        (r) => r.event === eventName && r.handlerName === `on ${eventName}`
      );
      if (r) r.handlerName = handlerName;
    }
  };
  for (const a of acts) {
    if (a.reactions)
      fixupReactions(
        a.reactions as ReactionNode[],
        a._sourceFile as string | undefined
      );
  }
  for (const s of slices) {
    fixupReactions(s.reactions as ReactionNode[]);
  }

  const model: DomainModel = {
    entries: [],
    states: [],
    slices: [],
    projections: [],
    reactions: [],
  };

  // Process each slice independently — one failure doesn't affect others
  const statesInSlices = new Set<string>();

  for (const s of slices) {
    const sliceName = (s._varName ?? "slice") as string;
    try {
      const sliceStateNames: string[] = [];
      for (const st of s.states) {
        if (!st || typeof st !== "object" || st._tag !== "State") continue;
        addState(model, st);
        const key = (st._modelKey ?? st.name) as string;
        sliceStateNames.push(key);
        statesInSlices.add(key);
      }

      const projNames: string[] = [];
      for (const p of s.projections) {
        if (!p || typeof p !== "object" || p._tag !== "Projection") continue;
        projNames.push(p.target as string);
      }

      model.slices.push({
        name: sliceName,
        states: sliceStateNames,
        stateVars: sliceStateNames,
        projections: projNames,
        reactions: s.reactions ?? [],
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      model.slices.push({
        name: sliceName,
        states: [],
        stateVars: [],
        projections: [],
        reactions: [],
        error: msg,
      });
    }
  }

  for (const p of projections) {
    model.projections.push({
      name: p.target,
      varName: p.target,
      handles: p.handles,
    });
  }

  // Fallback: scan source files for projection() calls not captured by mock eval
  // (e.g. circular dependencies prevent the projection file from evaluating before the act file)
  const capturedProjNames = new Set(model.projections.map((p) => p.name));
  for (const file of files) {
    /* v8 ignore next */ if (
      !file.path.endsWith(".ts") ||
      file.path.endsWith(".d.ts")
    )
      continue;
    const projRe = /\bprojection\(\s*["'`](\w+)["'`]\s*\)/g;
    let pm;
    while ((pm = projRe.exec(file.content)) !== null) {
      const projName = pm[1];
      /* v8 ignore next */ if (capturedProjNames.has(projName)) continue;
      /* v8 ignore next 5 -- resilience path for circular deps */
      const chain = file.content.slice(pm.index);
      const handles: string[] = [];
      const ponRe = /\.on\(\s*\{\s*(\w+)\s*(?:[:,}])/g;
      let hm;
      while ((hm = ponRe.exec(chain)) !== null) handles.push(hm[1]);
      /* v8 ignore next 2 */
      model.projections.push({ name: projName, varName: projName, handles });
      capturedProjNames.add(projName);
    }
  }

  const globalStateNames: string[] = [];

  for (const s of states) {
    if (!s || typeof s !== "object") continue;
    const key = s._modelKey ?? s.name;
    if (s._tag === "State" && !statesInSlices.has(key as string)) {
      try {
        addState(model, s);
        globalStateNames.push((s._modelKey ?? s.name) as string);
      } catch {
        /* skip corrupted standalone state */
      }
    }
  }

  for (const a of acts) {
    if (!a || typeof a !== "object") continue;
    for (const st of a.states ?? []) {
      if (!st || typeof st !== "object") continue;
      /* v8 ignore next -- _modelKey set by addState */
      const stKey = st._modelKey ?? st.name;
      if (st._tag === "State" && !statesInSlices.has(stKey as string)) {
        try {
          addState(model, st);
          globalStateNames.push((st._modelKey ?? st.name) as string);
        } catch {
          /* skip corrupted act state */
        }
      }
    }
    try {
      model.orchestrator = {
        slices: model.slices.map((s) => s.name),
        projections: model.projections.map((p) => p.name),
        states: model.states.map((s) => s.name),
      } as ActNode;
      for (const r of (a.reactions as ReactionNode[]) ?? []) {
        model.reactions.push(r);
      }

      /* v8 ignore next -- _sourceFile always set by capture callback */
      const entryPath = a._sourceFile ?? "app.ts";
      const actSliceNames = new Set<string>(
        /* v8 ignore next 5 -- _varName always set by slice tagging */
        ((a.slices as any[]) ?? []).map(
          (s: any) =>
            s._varName ?? s.states?.map((st: any) => st.name).join(", ") ?? ""
        )
      );
      const actStateNames = new Set<string>(
        ((a.states as any[]) ?? [])
          .filter((s: any) => s?._tag === "State")
          /* v8 ignore next -- _modelKey set by addState */
          .map((s: any) => s._modelKey ?? s.name)
      );
      const actProjNames = new Set<string>(
        ((a.projections as any[]) ?? [])
          .filter((p: any) => p?._tag === "Projection")
          .map((p: any) => p.target)
      );

      // Fallback: if act projections are empty (circular deps), scan source for .withProjection(Var)
      /* v8 ignore next 9 -- resilience path for circular deps */
      if (actProjNames.size === 0 && model.projections.length > 0) {
        const src = files.find((f) => f.path === entryPath)?.content ?? "";
        const wpRe = /\.withProjection\(\s*(?:\w+\.)*(\w+)\s*\)/g;
        while (wpRe.exec(src) !== null) {
          for (const p of model.projections) {
            actProjNames.add(p.name);
          }
        }
      }

      const entrySlices = model.slices.filter((s) => actSliceNames.has(s.name));
      const sliceStateNames = new Set(entrySlices.flatMap((s) => s.states));
      const allStateNames = new Set([...actStateNames, ...sliceStateNames]);

      model.entries.push({
        path: entryPath,
        states: model.states.filter((s) => allStateNames.has(s.varName)),
        slices: entrySlices,
        projections: model.projections.filter((p) => actProjNames.has(p.name)),
        reactions: a.reactions ?? [],
      });
    } catch {
      /* skip corrupted act entry */
    }
  }

  // Put standalone states/reactions into a "global" slice
  if (globalStateNames.length > 0 || model.reactions.length > 0) {
    model.slices.push({
      name: "global",
      states: globalStateNames,
      stateVars: globalStateNames,
      projections: model.projections.map((p) => p.name),
      reactions: model.reactions,
    });
  }

  // If no act() entries found but we have states/slices, create a single entry
  if (
    model.entries.length === 0 &&
    (model.states.length > 0 || model.slices.length > 0)
  ) {
    model.entries.push({
      path: "app",
      states: model.states,
      slices: model.slices,
      projections: model.projections,
      reactions: model.reactions,
    });
  }

  // Return global error only if nothing was extracted at all
  if (error && model.states.length === 0 && model.slices.length === 0) {
    return { model, error };
  }
  return { model };
}

let _stateIdx = 0;
function addState(model: DomainModel, st: any): void {
  const domainName = st.name as string;
  const uniqueKey = `${domainName}:${_stateIdx++}`;

  const events: EventNode[] = [];
  for (const eventName of Object.keys(
    (st.events ?? {}) as Record<string, unknown>
  )) {
    events.push({
      name: eventName,
      /* v8 ignore next -- patches always a Set from mock/regex builders */
      hasCustomPatch: st.patches?.has(eventName) ?? false,
    });
  }

  const actions: ActionNode[] = [];
  for (const actionName of Object.keys(
    (st.actions ?? {}) as Record<string, unknown>
  )) {
    if (actionName.startsWith("__emits_")) continue;
    const emits: string[] = st.actions[`__emits_${actionName}`] ?? [];
    const invariants = (st.given?.[actionName] ?? []).map(
      (inv: any) => inv.description ?? ""
    );
    actions.push({ name: actionName, emits, invariants });
  }

  model.states.push({
    name: domainName,
    varName: uniqueKey,
    events,
    actions,
    file: st._sourceFile as string | undefined,
  });
  st._modelKey = uniqueKey;
}
