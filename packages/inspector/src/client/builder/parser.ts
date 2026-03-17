/**
 * Regex-based parser for Act builder chains.
 * Extracts domain model from TypeScript source code.
 */

import type {
  DomainModel,
  EventNode,
  ProjectionNode,
  ReactionNode,
  SliceNode,
  StateNode,
} from "./types.js";

/** Parse Act builder code into a domain model */
export function parseActCode(code: string): DomainModel {
  const states = parseStates(code);
  const slices = parseSlices(code, states);
  const projections = parseProjections(code);
  const reactions = parseReactions(code);
  return { states, slices, projections, reactions };
}

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

/** Match balanced braces starting from a position */
function extractBalancedBraces(code: string, start: number): string {
  let depth = 0;
  let i = start;
  while (i < code.length) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return code.slice(start, i + 1);
    }
    i++;
  }
  return code.slice(start);
}

/** Find the end of a builder chain (.build() call) */
function findChain(code: string, start: number): string {
  // Find matching .build() — scan forward tracking brace depth
  let i = start;
  let depth = 0;
  while (i < code.length) {
    if (code[i] === "(" || code[i] === "{") depth++;
    else if (code[i] === ")" || code[i] === "}") depth--;

    if (depth <= 0 && code.slice(i).startsWith(".build()")) {
      return code.slice(start, i + 8);
    }
    i++;
  }
  // Fallback: to end of statement
  const semi = code.indexOf(";", start);
  return code.slice(start, semi !== -1 ? semi + 1 : code.length);
}

/** Extract top-level keys from an object literal (handles nested braces) */
function extractObjectKeys(objBody: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < objBody.length; i++) {
    const ch = objBody[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (depth === 0 && ch === ":") {
      const key = current.trim();
      if (key && /^\w+$/.test(key)) keys.push(key);
      current = "";
      continue;
    } else if (depth === 0 && ch === ",") {
      current = "";
      continue;
    }
    if (depth === 0) current += ch;
  }
  return keys;
}

/** Resolve a variable name to its object keys */
function resolveVarKeys(code: string, varName: string): string[] {
  // Match: const VarName = { key1: ..., key2: ... }
  const re = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*\\{`, "s");
  const m = re.exec(code);
  if (!m) return [];
  const braceStart = m.index + m[0].length - 1;
  const body = extractBalancedBraces(code, braceStart);
  // Strip outer braces
  return extractObjectKeys(body.slice(1, -1));
}

/** Extract state() builder chains */
function parseStates(code: string): StateNode[] {
  const states: StateNode[] = [];

  // Match: [const|let] VarName = state({ StateName: ... })
  const stateRe =
    /(?:(?:const|let|var)\s+(\w+)\s*=\s*)?state\(\s*\{\s*(\w+)\s*:/g;
  let match: RegExpExecArray | null;

  while ((match = stateRe.exec(code)) !== null) {
    const varName = match[1] || match[2];
    const name = match[2];
    const startIdx = match.index;
    const line = lineOf(code, startIdx);
    const chain = findChain(code, startIdx);

    const events = parseEmits(chain, code);
    const patchedEvents = parsePatchedEvents(chain);
    for (const e of events) {
      e.hasCustomPatch = patchedEvents.has(e.name);
    }

    const actions = parseActions(chain, code, startIdx);
    states.push({ name, varName, events, actions, line });
  }

  return states;
}

/** Extract event names from .emits({ ... }) or .emits(VarRef) */
function parseEmits(chain: string, fullCode: string): EventNode[] {
  const events: EventNode[] = [];
  const seen = new Set<string>();

  // Inline object: .emits({ Key1: ..., Key2: ... })
  const inlineRe = /\.emits\(\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(chain)) !== null) {
    const braceStart = m.index + m[0].length - 1;
    const body = extractBalancedBraces(chain, braceStart);
    for (const key of extractObjectKeys(body.slice(1, -1))) {
      if (!seen.has(key)) {
        seen.add(key);
        events.push({ name: key, hasCustomPatch: false });
      }
    }
  }

  // Variable reference: .emits(VarName)
  const varRe = /\.emits\(\s*(\w+)\s*\)/g;
  while ((m = varRe.exec(chain)) !== null) {
    for (const key of resolveVarKeys(fullCode, m[1])) {
      if (!seen.has(key)) {
        seen.add(key);
        events.push({ name: key, hasCustomPatch: false });
      }
    }
  }

  return events;
}

/** Extract events with custom .patch() reducers */
function parsePatchedEvents(chain: string): Set<string> {
  const patched = new Set<string>();

  const inlineRe = /\.patch\(\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(chain)) !== null) {
    const braceStart = m.index + m[0].length - 1;
    const body = extractBalancedBraces(chain, braceStart);
    for (const key of extractObjectKeys(body.slice(1, -1))) {
      patched.add(key);
    }
  }

  return patched;
}

/** Extract .on({ ActionName: ... }) actions with emits and invariants */
function parseActions(
  chain: string,
  fullCode: string,
  chainOffset: number
): { name: string; emits: string[]; invariants: string[]; line?: number }[] {
  const actions: {
    name: string;
    emits: string[];
    invariants: string[];
    line?: number;
  }[] = [];

  // Find all .on({ ... }) positions
  const onPositions: { name: string; index: number }[] = [];
  const onRe = /\.on\(\s*\{\s*(\w+)\s*[,:]/g;
  let m: RegExpExecArray | null;
  while ((m = onRe.exec(chain)) !== null) {
    onPositions.push({ name: m[1], index: m.index });
  }

  for (let i = 0; i < onPositions.length; i++) {
    const { name, index } = onPositions[i];
    const line = lineOf(fullCode, chainOffset + index);

    // Scope: from this .on() to the next .on() or end of chain
    const nextIdx =
      i < onPositions.length - 1 ? onPositions[i + 1].index : chain.length;
    const scope = chain.slice(index, nextIdx);

    // Extract emitted events
    const emits: string[] = [];

    // .emit("EventName") — string passthrough
    const emitStr = /\.emit\(\s*"(\w+)"\s*\)/.exec(scope);
    if (emitStr) emits.push(emitStr[1]);

    // .emit((args) => ["EventName", ...]) or .emit((args) => { return ["EventName", ...] })
    // Scan for all quoted event names in the emit body
    if (!emitStr) {
      const emitFn = /\.emit\(/.exec(scope);
      if (emitFn) {
        const emitBody = scope.slice(emitFn.index);
        const eventRefs = /\[\s*"(\w+)"/g;
        let er: RegExpExecArray | null;
        while ((er = eventRefs.exec(emitBody)) !== null) {
          if (!emits.includes(er[1])) emits.push(er[1]);
        }
        // Also: return ["EventName", ...]
        const returnRefs = /return\s+\[?\s*"(\w+)"/g;
        while ((er = returnRefs.exec(emitBody)) !== null) {
          if (!emits.includes(er[1])) emits.push(er[1]);
        }
      }
    }

    // Extract invariants
    const invariants: string[] = [];
    const givenRe = /\.given\(\s*\[/;
    const gm = givenRe.exec(scope);
    if (gm) {
      const givenBody = scope.slice(gm.index);
      // Inline descriptions
      const descRe = /description\s*:\s*"([^"]*)"/g;
      let dm: RegExpExecArray | null;
      while ((dm = descRe.exec(givenBody)) !== null) {
        invariants.push(dm[1]);
      }
      // Variable references (mustBeOpen, mustBeX)
      const varRefs = /\b(must\w+|is\w+|can\w+)\b/gi;
      let vr: RegExpExecArray | null;
      while ((vr = varRefs.exec(givenBody)) !== null) {
        if (
          !invariants.includes(vr[1]) &&
          vr[1] !== "mustBeOpen" // avoid duplicating if already found via description
        ) {
          invariants.push(vr[1]);
        }
      }
    }

    actions.push({ name, emits, invariants, line });
  }

  return actions;
}

/** Extract handler function name from .do(async function NAME(...)) or .do(async (event...) => ...) */
function extractHandlerName(scope: string, eventName: string): string {
  // Named function: .do(async function name(
  const namedFn = /\.do\(\s*async\s+function\s+(\w+)/;
  const m = namedFn.exec(scope);
  if (m) return m[1];
  // Fallback: use event name
  return `on${eventName}`;
}

/** Extract app.do("ActionName", ...) calls from a reaction handler scope */
function extractDispatches(scope: string): string[] {
  const dispatches: string[] = [];
  const doRe = /app\.do\(\s*"(\w+)"/g;
  let m: RegExpExecArray | null;
  while ((m = doRe.exec(scope)) !== null) {
    if (!dispatches.includes(m[1])) dispatches.push(m[1]);
  }
  return dispatches;
}

/** Extract slice() builder chains, resolving state variable names */
function parseSlices(code: string, states: StateNode[]): SliceNode[] {
  const slices: SliceNode[] = [];
  const sliceRe = /(?:const|let|var)\s+(\w+)\s*=\s*slice\(\)/g;
  let match: RegExpExecArray | null;

  // Map variable name → state domain name
  const varToState = new Map<string, string>();
  for (const s of states) {
    varToState.set(s.varName, s.name);
  }

  while ((match = sliceRe.exec(code)) !== null) {
    const name = match[1];
    const line = lineOf(code, match.index);
    const chain = findChain(code, match.index);

    // .withState(VarName) → resolve to state domain names
    const stateNames: string[] = [];
    const stateVars: string[] = [];
    const wsRe = /\.withState\(\s*(\w+)\s*\)/g;
    let wm: RegExpExecArray | null;
    while ((wm = wsRe.exec(chain)) !== null) {
      stateVars.push(wm[1]);
      const resolved = varToState.get(wm[1]) ?? wm[1];
      if (!stateNames.includes(resolved)) stateNames.push(resolved);
    }

    // .withProjection(VarName)
    const projNames: string[] = [];
    const wpRe = /\.withProjection\(\s*(\w+)\s*\)/g;
    while ((wm = wpRe.exec(chain)) !== null) {
      projNames.push(wm[1]);
    }

    // .on("EventName") — reactions
    const reactions: ReactionNode[] = [];
    const onRe = /\.on\(\s*"(\w+)"\s*\)/g;
    while ((wm = onRe.exec(chain)) !== null) {
      const afterOn = chain.slice(wm.index);
      const nextOn = afterOn.indexOf('.on("', 5);
      const scope = nextOn > 0 ? afterOn.slice(0, nextOn) : afterOn;
      const isVoid = scope.includes(".void()");
      reactions.push({
        event: wm[1],
        handlerName: extractHandlerName(scope, wm[1]),
        dispatches: extractDispatches(scope),
        isVoid,
        line: lineOf(code, match.index + wm.index),
      });
    }

    slices.push({
      name,
      states: stateNames,
      stateVars,
      projections: projNames,
      reactions,
      line,
    });
  }

  return slices;
}

/** Extract projection() builder chains */
function parseProjections(code: string): ProjectionNode[] {
  const projections: ProjectionNode[] = [];
  const projRe =
    /(?:const|let|var)\s+(\w+)\s*=\s*projection\(\s*"?(\w*)"?\s*\)/g;
  let match: RegExpExecArray | null;

  while ((match = projRe.exec(code)) !== null) {
    const varName = match[1];
    const name = match[2] || varName;
    const line = lineOf(code, match.index);
    const chain = findChain(code, match.index);

    const handles: string[] = [];
    const onRe = /\.on\(\s*\{/g;
    let om: RegExpExecArray | null;
    while ((om = onRe.exec(chain)) !== null) {
      const braceStart = om.index + om[0].length - 1;
      const body = extractBalancedBraces(chain, braceStart);
      for (const key of extractObjectKeys(body.slice(1, -1))) {
        if (!handles.includes(key)) handles.push(key);
      }
    }

    projections.push({ name, handles, line });
  }

  return projections;
}

/** Extract inline reactions from act() builder */
function parseReactions(code: string): ReactionNode[] {
  const reactions: ReactionNode[] = [];
  const actRe = /act\(\)/g;
  let match: RegExpExecArray | null;

  while ((match = actRe.exec(code)) !== null) {
    const chain = findChain(code, match.index);
    const onRe = /\.on\(\s*"(\w+)"\s*\)/g;
    let om: RegExpExecArray | null;
    while ((om = onRe.exec(chain)) !== null) {
      const afterOn = chain.slice(om.index);
      const nextOn = afterOn.indexOf('.on("', 5);
      const scope = nextOn > 0 ? afterOn.slice(0, nextOn) : afterOn;
      const isVoid = scope.includes(".void()");
      reactions.push({
        event: om[1],
        handlerName: extractHandlerName(scope, om[1]),
        dispatches: extractDispatches(scope),
        isVoid,
        line: lineOf(code, match.index + om.index),
      });
    }
  }

  return reactions;
}
