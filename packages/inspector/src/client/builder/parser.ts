/**
 * Regex-based parser for Act builder chains.
 * Extracts domain model from TypeScript source code.
 */

import type {
  ActionNode,
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
  const slices = parseSlices(code);
  const projections = parseProjections(code);
  const reactions = parseReactions(code);
  return { states, slices, projections, reactions };
}

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

/** Extract state() builder chains */
function parseStates(code: string): StateNode[] {
  const states: StateNode[] = [];
  // Match: state({ Name: ... }) or state({ Name: Schema })
  const stateRe = /state\(\s*\{\s*(\w+)\s*:/g;
  let match: RegExpExecArray | null;

  while ((match = stateRe.exec(code)) !== null) {
    const name = match[1];
    const startIdx = match.index;
    const line = lineOf(code, startIdx);

    // Find the builder chain scope (from state() to .build())
    const chainEnd = findBuildEnd(code, startIdx);
    const chain = code.slice(startIdx, chainEnd);

    const events = parseEmits(chain, code, startIdx);
    const patchedEvents = parsePatchedEvents(chain);
    for (const e of events) {
      e.hasCustomPatch = patchedEvents.has(e.name);
    }

    const actions = parseActions(chain, code, startIdx);

    states.push({ name, events, actions, line });
  }

  return states;
}

/** Extract .emits({ ... }) event names */
function parseEmits(
  chain: string,
  fullCode: string,
  chainOffset: number
): EventNode[] {
  const events: EventNode[] = [];
  const emitsRe = /\.emits\(\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;

  while ((match = emitsRe.exec(chain)) !== null) {
    const body = match[1];
    // Extract event names (keys of the object)
    const keyRe = /(\w+)\s*:/g;
    let km: RegExpExecArray | null;
    while ((km = keyRe.exec(body)) !== null) {
      events.push({
        name: km[1],
        hasCustomPatch: false,
        line: lineOf(fullCode, chainOffset + (match.index ?? 0)),
      });
    }
  }

  // Also handle .emits(VariableName) — reference to an object
  const emitsVarRe = /\.emits\(\s*(\w+)\s*\)/g;
  while ((match = emitsVarRe.exec(chain)) !== null) {
    const varName = match[1];
    // Try to find the variable definition in full code
    const varRe = new RegExp(
      `(?:const|let)\\s+${varName}\\s*=\\s*\\{([^}]*)\\}`,
      "s"
    );
    const vm = varRe.exec(fullCode);
    if (vm) {
      const keyRe = /(\w+)\s*:/g;
      let km: RegExpExecArray | null;
      while ((km = keyRe.exec(vm[1])) !== null) {
        events.push({
          name: km[1],
          hasCustomPatch: false,
          line: lineOf(fullCode, chainOffset + match.index),
        });
      }
    }
  }

  return events;
}

/** Extract events with custom .patch() reducers */
function parsePatchedEvents(chain: string): Set<string> {
  const patched = new Set<string>();
  const patchRe = /\.patch\(\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;

  while ((match = patchRe.exec(chain)) !== null) {
    const body = match[1];
    const keyRe = /(\w+)\s*:/g;
    let km: RegExpExecArray | null;
    while ((km = keyRe.exec(body)) !== null) {
      patched.add(km[1]);
    }
  }

  return patched;
}

/** Extract .on({ ActionName: ... }) actions */
function parseActions(
  chain: string,
  fullCode: string,
  chainOffset: number
): ActionNode[] {
  const actions: ActionNode[] = [];
  // Match .on({ ActionName: ... }) followed by optional .given() and .emit()
  const onRe = /\.on\(\s*\{\s*(\w+)\s*:/g;
  let match: RegExpExecArray | null;

  while ((match = onRe.exec(chain)) !== null) {
    const name = match[1];
    const line = lineOf(fullCode, chainOffset + match.index);

    // Look ahead for .emit() and .given() in the chain after this .on()
    const afterOn = chain.slice(match.index + match[0].length);

    // Extract emitted events
    const emits: string[] = [];
    // .emit("EventName") — string passthrough
    const emitStrRe = /\.emit\(\s*"(\w+)"/;
    const esm = emitStrRe.exec(afterOn);
    if (esm) emits.push(esm[1]);

    // .emit((data) => ["EventName", ...]) — function with event name
    const emitFnRe =
      /\.emit\(\s*\([^)]*\)\s*=>\s*(?:\[?\s*\[?\s*"(\w+)"|(?:return\s+)?\[?\s*"(\w+)")/;
    const efm = emitFnRe.exec(afterOn);
    if (efm) {
      const ename = efm[1] || efm[2];
      if (ename && !emits.includes(ename)) emits.push(ename);
    }

    // Multiple events in emit function body
    const multiEmitRe = /"(\w+)"\s*,\s*\{/g;
    let mem: RegExpExecArray | null;
    const emitBody = afterOn.slice(
      0,
      afterOn.indexOf(".on(") > 0 ? afterOn.indexOf(".on(") : 500
    );
    while ((mem = multiEmitRe.exec(emitBody)) !== null) {
      if (!emits.includes(mem[1])) emits.push(mem[1]);
    }

    // Extract invariants from .given([...])
    const invariants: string[] = [];
    const givenRe = /\.given\(\s*\[([^\]]*)\]/s;
    const gm = givenRe.exec(afterOn);
    if (gm) {
      // Extract description strings
      const descRe = /description\s*:\s*"([^"]*)"/g;
      let dm: RegExpExecArray | null;
      while ((dm = descRe.exec(gm[1])) !== null) {
        invariants.push(dm[1]);
      }
      // Also try variable references
      const varRefRe = /(\w+(?:Must\w+|must\w+|is\w+|can\w+))/g;
      let vr: RegExpExecArray | null;
      while ((vr = varRefRe.exec(gm[1])) !== null) {
        if (!invariants.includes(vr[1])) invariants.push(vr[1]);
      }
    }

    actions.push({ name, emits, invariants, line });
  }

  return actions;
}

/** Extract slice() builder chains */
function parseSlices(code: string): SliceNode[] {
  const slices: SliceNode[] = [];
  // Match: const Name = slice() or variable = slice()
  const sliceRe = /(?:const|let)\s+(\w+)\s*=\s*slice\(\)/g;
  let match: RegExpExecArray | null;

  while ((match = sliceRe.exec(code)) !== null) {
    const name = match[1];
    const line = lineOf(code, match.index);
    const chainEnd = findBuildEnd(code, match.index);
    const chain = code.slice(match.index, chainEnd);

    // Extract .withState(StateName)
    const stateNames: string[] = [];
    const wsRe = /\.withState\(\s*(\w+)\s*\)/g;
    let wm: RegExpExecArray | null;
    while ((wm = wsRe.exec(chain)) !== null) {
      stateNames.push(wm[1]);
    }

    // Extract .withProjection(ProjName)
    const projNames: string[] = [];
    const wpRe = /\.withProjection\(\s*(\w+)\s*\)/g;
    while ((wm = wpRe.exec(chain)) !== null) {
      projNames.push(wm[1]);
    }

    // Extract reactions: .on("EventName")
    const reactions: ReactionNode[] = [];
    const onRe = /\.on\(\s*"(\w+)"\s*\)/g;
    while ((wm = onRe.exec(chain)) !== null) {
      const isVoid = chain.slice(wm.index).includes(".void()");
      reactions.push({
        event: wm[1],
        isVoid,
        line: lineOf(code, match.index + wm.index),
      });
    }

    slices.push({
      name,
      states: stateNames,
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
  const projRe = /(?:const|let)\s+(\w+)\s*=\s*projection\(\s*"?(\w*)"?\s*\)/g;
  let match: RegExpExecArray | null;

  while ((match = projRe.exec(code)) !== null) {
    const varName = match[1];
    const name = match[2] || varName;
    const line = lineOf(code, match.index);
    const chainEnd = findBuildEnd(code, match.index);
    const chain = code.slice(match.index, chainEnd);

    // Extract handled events: .on({ EventName: ... })
    const handles: string[] = [];
    const onRe = /\.on\(\s*\{\s*(\w+)\s*[,:}]/g;
    let om: RegExpExecArray | null;
    while ((om = onRe.exec(chain)) !== null) {
      handles.push(om[1]);
    }

    projections.push({ name, handles, line });
  }

  return projections;
}

/** Extract inline reactions from act() builder */
function parseReactions(code: string): ReactionNode[] {
  const reactions: ReactionNode[] = [];
  // Look for act().on("EventName") patterns
  const actRe = /act\(\)/g;
  let match: RegExpExecArray | null;

  while ((match = actRe.exec(code)) !== null) {
    const chainEnd = findBuildEnd(code, match.index);
    const chain = code.slice(match.index, chainEnd);

    const onRe = /\.on\(\s*"(\w+)"\s*\)/g;
    let om: RegExpExecArray | null;
    while ((om = onRe.exec(chain)) !== null) {
      const isVoid = chain.slice(om.index).includes(".void()");
      reactions.push({
        event: om[1],
        isVoid,
        line: lineOf(code, match.index + om.index),
      });
    }
  }

  return reactions;
}

/** Find the end of a builder chain (.build() call or end of statement) */
function findBuildEnd(code: string, start: number): number {
  const buildIdx = code.indexOf(".build()", start);
  if (buildIdx !== -1) return buildIdx + 8;
  // Fallback: find next top-level statement
  const semiIdx = code.indexOf(";", start);
  return semiIdx !== -1 ? semiIdx + 1 : code.length;
}
