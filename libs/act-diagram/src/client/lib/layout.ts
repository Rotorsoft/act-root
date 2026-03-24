/**
 * Pure layout computation for Act domain model diagrams.
 *
 * Extracted from Diagram.tsx so rendering rules can be unit-tested
 * without React or DOM dependencies.
 */
import type { DomainModel, StateNode } from "../types/index.js";

// ── Constants ────────────────────────────────────────────────────────
export const W = 100,
  H = 36,
  STATE_W = 80,
  STATE_H = 80,
  GAP = 12,
  PAD = 10,
  SLICE_PAD = 24,
  SLICE_INNER = 16,
  SLICE_GAP = 20,
  MARGIN = 30;

const COLORS = {
  action: { bg: "#1e40af", border: "#3b82f6", text: "#93c5fd" },
  event: { bg: "#c2410c", border: "#f97316", text: "#fed7aa" },
  state: { bg: "#a16207", border: "#eab308", text: "#fef08a" },
  reaction: { bg: "#7e22ce", border: "#a855f7", text: "#d8b4fe" },
  projection: { bg: "#15803d", border: "#22c55e", text: "#bbf7d0" },
};

// ── Types ────────────────────────────────────────────────────────────
export type Pos = { x: number; y: number };
export type N = {
  key: string;
  pos: Pos;
  type: keyof typeof COLORS;
  label: string;
  sub?: string;
  file?: string;
  projections?: string[];
  guards?: string[];
  reactions?: string[];
};
export type E = { from: Pos; to: Pos; color: string; dash?: boolean };
export type Box = {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  error?: string;
};
export type Layout = {
  ns: N[];
  es: E[];
  boxes: Box[];
  minX: number;
  minY: number;
  width: number;
  height: number;
};

// ── Recursive chain measurement ──────────────────────────────────────

type ReactionDef = {
  event: string;
  handlerName: string;
  dispatches: string[];
  isVoid: boolean;
};

type EmitMeasure = {
  name: string;
  h: number; // H if no sub-chain, or sub-chain groupH if it has one
  subChain?: ChainMeasure;
  subReaction?: ReactionDef;
};
type RowMeasure = {
  an: string;
  rowH: number;
  emitInfos: EmitMeasure[];
  emitsH: number;
  targetState: StateNode | undefined;
};
type ChainMeasure = {
  groupH: number;
  dispatchBlockH: number;
  rows: RowMeasure[];
};

/** Measure a reaction chain recursively (leaves first) */
function measureChain(
  rDef: ReactionDef,
  lookup: Map<string, ReactionDef>,
  visited: Set<string>,
  allStates: StateNode[]
): ChainMeasure {
  const rows: RowMeasure[] = [];
  let dispatchBlockH = 0;

  for (const an of rDef.dispatches) {
    const targetAction = allStates
      .flatMap((s) => s.actions)
      .find((a) => a.name === an);
    const targetState = allStates.find((s) =>
      s.actions.some((a) => a.name === an)
    );
    const emitNames = targetAction?.emits ?? [];

    const emitInfos: EmitMeasure[] = [];
    let emitsH = 0;
    for (const en of emitNames) {
      const subR = lookup.get(en);
      let eventH = H;
      let subChain: ChainMeasure | undefined;
      if (subR && !visited.has(subR.handlerName)) {
        visited.add(subR.handlerName);
        subChain = measureChain(subR, lookup, visited, allStates);
        eventH = Math.max(H, subChain.groupH);
      }
      emitInfos.push({
        name: en,
        h: eventH,
        subChain,
        subReaction: subR && subChain ? subR : undefined,
      });
      emitsH += eventH;
    }

    const rowH = Math.max(H, targetState ? STATE_H : 0, emitsH || H);
    rows.push({ an, rowH, emitInfos, emitsH, targetState });
    if (dispatchBlockH > 0) dispatchBlockH += GAP / 2;
    dispatchBlockH += rowH;
  }

  return { groupH: Math.max(H, dispatchBlockH), dispatchBlockH, rows };
}

/**
 * Place a reaction chain recursively.
 * The reaction aligns with the triggering event (reactionY).
 * The dispatched block is centered relative to the reaction.
 */
function placeChain(
  measure: ChainMeasure,
  rDef: ReactionDef,
  reactionY: number,
  rX: number,
  triggeredFromX: number,
  triggeredFromY: number,
  ns: N[],
  es: E[],
  sliceName: string,
  lookup: Map<string, ReactionDef>,
  eventProjections: Map<string, string[]>,
  eventReactions: Map<string, string[]>,
  sliceRightXRef: { value: number }
): void {
  const dispatchBaseX = rX + W + GAP;

  // Reaction node — aligned with triggering event
  const rp = { x: rX, y: reactionY };
  ns.push({
    key: `r:${rDef.handlerName}:${sliceName}`,
    pos: rp,
    type: "reaction",
    label: rDef.handlerName,
  });
  es.push({
    from: { x: triggeredFromX, y: triggeredFromY },
    to: { x: rp.x, y: rp.y + H / 2 },
    color: COLORS.reaction.border,
    dash: true,
  });

  // Dispatched rows — centered vertically relative to reaction center
  const reactionCenterY = reactionY + H / 2;
  let dispatchY = reactionCenterY - measure.dispatchBlockH / 2;

  for (const row of measure.rows) {
    const rowCenterY = dispatchY + row.rowH / 2;
    let nextX = dispatchBaseX;

    // Dispatched action — centered in row
    const dap = { x: nextX, y: rowCenterY - H / 2 };
    const dispatchedAction = row.targetState?.actions.find(
      (a) => a.name === row.an
    );
    ns.push({
      key: `a:${row.an}:dispatched:${rDef.handlerName}`,
      pos: dap,
      type: "action",
      label: row.an,
      sub:
        dispatchedAction && dispatchedAction.invariants.length > 0
          ? "guarded"
          : undefined,
      guards:
        dispatchedAction && dispatchedAction.invariants.length > 0
          ? dispatchedAction.invariants
          : undefined,
      file: row.targetState?.file,
    });
    es.push({
      from: { x: rp.x + W, y: rp.y + H / 2 },
      to: { x: dap.x, y: dap.y + H / 2 },
      color: COLORS.reaction.border,
      dash: true,
    });
    nextX += W + GAP;

    // Dispatched state — centered in row
    if (row.targetState) {
      ns.push({
        key: `s:${row.targetState.name}:dispatched:${rDef.handlerName}:${row.an}`,
        pos: { x: nextX, y: rowCenterY - STATE_H / 2 },
        type: "state",
        label: row.targetState.name,
        file: row.targetState.file,
      });
      nextX += STATE_W + GAP;
    }

    // Dispatched events — vertically centered with the state box,
    // each event node is H tall; sub-chains extend rightward
    const evtX = nextX;
    const nEvents = row.emitInfos.length;
    const eventsOnlyH = nEvents * H + (nEvents - 1) * (GAP / 2);
    let emitY = rowCenterY - eventsOnlyH / 2;
    for (const emit of row.emitInfos) {
      ns.push({
        key: `e:${emit.name}:dispatched:${rDef.handlerName}:${row.an}`,
        pos: { x: evtX, y: emitY },
        type: "event",
        label: emit.name,
        file: row.targetState?.file,
        projections: eventProjections.get(emit.name),
        reactions: eventReactions.get(emit.name),
      });

      // Recurse into sub-chain — reaction aligns with this emit
      if (emit.subChain && emit.subReaction) {
        const subRX = evtX + W + GAP * 3;
        placeChain(
          emit.subChain,
          emit.subReaction,
          emitY, // reaction aligns with emit
          subRX,
          evtX + W,
          emitY + H / 2,
          ns,
          es,
          sliceName,
          lookup,
          eventProjections,
          eventReactions,
          sliceRightXRef
        );
      }

      emitY += H + GAP / 2;
    }
    if (row.emitInfos.length > 0) nextX = evtX + W + GAP;
    sliceRightXRef.value = Math.max(sliceRightXRef.value, nextX);
    dispatchY += row.rowH + GAP / 2;
  }
}

// ── Layout computation ───────────────────────────────────────────────
export function computeLayout(viewModel: DomainModel): Layout {
  const ns: N[] = [];
  const es: E[] = [];
  const boxes: Box[] = [];
  const sv = new Map<string, StateNode>();
  for (const s of viewModel.states) {
    sv.set(s.varName, s);
    sv.set(s.name, s);
  }

  // Build projection lookup: event name → projection names
  const eventProjections = new Map<string, string[]>();
  const eventReactions = new Map<string, string[]>();

  for (const slice of viewModel.slices) {
    for (const r of slice.reactions) {
      if (r.isVoid) continue;
      const list = eventReactions.get(r.event) ?? [];
      list.push(r.handlerName);
      eventReactions.set(r.event, list);
    }
  }
  for (const r of viewModel.reactions) {
    if (r.isVoid) continue;
    const list = eventReactions.get(r.event) ?? [];
    list.push(r.handlerName);
    eventReactions.set(r.event, list);
  }
  for (const proj of viewModel.projections) {
    for (const en of proj.handles) {
      const list = eventProjections.get(en) ?? [];
      list.push(proj.name);
      eventProjections.set(en, list);
    }
  }

  // eslint-disable-next-line no-useless-assignment
  let cx = PAD;
  let globalY = 0;

  /**
   * Layout per slice: [Action] → [State] → [Event] per action row
   * State node placed between actions and events (one per slice).
   * Reactions extend the flow to the right of events.
   */
  // Sort slices by name for stable layout across re-extractions
  const sortedSlices = [...viewModel.slices].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const slice of sortedSlices) {
    // Error slices get a minimum-sized box with the error message
    if (slice.error && slice.states.length === 0) {
      const sx = PAD;
      const errorW = Math.max(300, slice.error.length * 5);
      const nameH = slice.name.length * 7;
      const errorH = Math.max(H * 2 + GAP, nameH + GAP * 2);
      boxes.push({
        label: slice.name,
        x: sx - GAP / 2,
        y: globalY,
        w: errorW,
        h: errorH,
        error: slice.error,
      });
      globalY += errorH + SLICE_GAP;
      continue;
    }

    // Phase 1: layout slice content at y=0, then translate to globalY
    cx = PAD;
    const sx = cx;
    cx += SLICE_PAD + GAP;
    // Merge partial states with the same domain name within a slice
    // Track which source file each event/action came from
    const eventFileMap = new Map<string, string>();
    const actionFileMap = new Map<string, string>();
    const rawParts = slice.stateVars
      .map((v) => sv.get(v))
      .filter(Boolean) as StateNode[];
    const mergedByName = new Map<string, StateNode>();
    for (const st of rawParts) {
      // Record source file for each event and action
      for (const e of st.events) {
        if (st.file) eventFileMap.set(e.name, st.file);
      }
      for (const a of st.actions) {
        if (st.file) actionFileMap.set(a.name, st.file);
      }
      const existing = mergedByName.get(st.name);
      if (existing) {
        // Merge actions and events, avoiding duplicates
        const actionNames = new Set(existing.actions.map((a) => a.name));
        for (const a of st.actions) {
          if (!actionNames.has(a.name)) existing.actions.push(a);
        }
        const eventNames = new Set(existing.events.map((e) => e.name));
        for (const e of st.events) {
          if (!eventNames.has(e.name)) existing.events.push(e);
        }
      } else {
        // Clone so we don't mutate the original
        mergedByName.set(st.name, {
          ...st,
          actions: [...st.actions],
          events: [...st.events],
        });
      }
    }
    const parts = [...mergedByName.values()];

    let y = SLICE_INNER; // layout relative to y=0
    let sliceRightX = cx;
    const sliceNodeStart = ns.length;
    const sliceEdgeStart = es.length;

    // Build event→reactions lookup within this slice (supports multiple per event)
    const sliceReactionsByEvent = new Map<string, typeof slice.reactions>();
    for (const r of slice.reactions) {
      if (r.isVoid) continue;
      const list = sliceReactionsByEvent.get(r.event) ?? [];
      list.push(r);
      sliceReactionsByEvent.set(r.event, list);
    }
    // Single-reaction lookup for chain measurement (uses first reaction)
    const sliceReactionByEvent = new Map<string, (typeof slice.reactions)[0]>();
    for (const [event, reactions] of sliceReactionsByEvent) {
      sliceReactionByEvent.set(event, reactions[0]);
    }

    // Track visited events/reactions to prevent cycles
    const visitedEvents = new Set<string>();
    const visitedReactions = new Set<string>();

    let partIdx = 0;
    for (const st of parts) {
      // Extra vertical separation between states within a slice
      if (partIdx > 0) y += GAP * 2;
      const stateColX = cx + W + GAP;
      const eventColX = stateColX + STATE_W + GAP;

      // ── Pre-calculate sizes ────────────────────────────────────
      const eventRows: { eventName: string; actionName: string }[] = [];
      const actionEmitted = new Set<string>();
      for (const action of st.actions) {
        for (const en of action.emits) {
          actionEmitted.add(en);
        }
      }
      // Trigger events first (declared in .emits() but not produced by any
      // action) — these are chain entry points and must be processed before
      // their downstream events so the full serial chain is detected
      for (const ev of st.events) {
        if (!actionEmitted.has(ev.name)) {
          eventRows.push({ eventName: ev.name, actionName: "" });
        }
      }
      for (const action of st.actions) {
        for (const en of action.emits) {
          eventRows.push({ eventName: en, actionName: action.name });
        }
      }
      // ── Measure per-event heights (including sub-chains) ─────
      type EventMeasure = {
        eventName: string;
        actionName: string;
        h: number;
        chains: Array<{ chain: ChainMeasure; reaction: ReactionDef }>;
      };
      const measuredEvents: EventMeasure[] = [];
      let evtBlockH = 0;
      for (const { eventName: en, actionName } of eventRows) {
        const chains: Array<{ chain: ChainMeasure; reaction: ReactionDef }> =
          [];
        if (!visitedEvents.has(en)) {
          const rDefs = sliceReactionsByEvent.get(en) ?? [];
          for (const rDef of rDefs) {
            if (visitedReactions.has(rDef.handlerName)) continue;
            visitedReactions.add(rDef.handlerName);
            const chain = measureChain(
              rDef,
              sliceReactionByEvent,
              visitedReactions,
              viewModel.states
            );
            chains.push({ chain, reaction: rDef });
          }
          if (rDefs.length > 0) visitedEvents.add(en);
        }
        measuredEvents.push({
          eventName: en,
          actionName,
          h: H,
          chains,
        });
        if (evtBlockH > 0) evtBlockH += GAP / 2;
        // Primary event always claims H in the event column —
        // chain height extends rightward, not downward
        evtBlockH += H;
      }
      if (evtBlockH === 0) evtBlockH = H;

      const nActs = st.actions.length;
      const actBlockH = nActs * H + (nActs - 1) * (GAP / 2);
      const primaryBlockH = Math.max(evtBlockH, actBlockH, STATE_H);
      const stCenterY = y + primaryBlockH / 2;

      // ── State box (fixed square, vertically centered) ─────────
      ns.push({
        key: `s:${st.name}:${slice.name}`,
        pos: { x: stateColX, y: stCenterY - STATE_H / 2 },
        type: "state",
        label: st.name,
        file: st.file,
      });

      // ── Events centered, chains extend right with watermark ────
      const sliceRightXRef = { value: sliceRightX };
      let evtY = stCenterY - evtBlockH / 2;
      let chainWatermark = -Infinity; // tracks lowest Y used by chains
      const eventYMap = new Map<string, number>();

      for (let ei = 0; ei < measuredEvents.length; ei++) {
        const { eventName: en, actionName, chains } = measuredEvents[ei];
        ns.push({
          key: `e:${en}:${slice.name}:${actionName}`,
          pos: { x: eventColX, y: evtY },
          type: "event",
          label: en,
          file: eventFileMap.get(en) ?? st.file,
          projections: eventProjections.get(en),
          reactions: eventReactions.get(en),
        });
        eventYMap.set(en, evtY);

        // Place all reaction chains for this event — each aligns with
        // the event when possible, pushed down by watermark when
        // previous chains need space
        for (const { chain, reaction: chainReaction } of chains) {
          const rX = eventColX + W + GAP * 3;
          // Reaction must be placed so its dispatched block doesn't
          // overlap previous chains. The block extends dispatchBlockH/2
          // above the reaction center, so:
          //   reactionCenter - dispatchBlockH/2 >= chainWatermark
          //   reactionY + H/2 - dispatchBlockH/2 >= chainWatermark
          //   reactionY >= chainWatermark - H/2 + dispatchBlockH/2
          const minReactionY =
            chainWatermark + chain.dispatchBlockH / 2 - H / 2;
          const reactionY = Math.max(evtY, minReactionY);
          const chainStartIdx = ns.length;
          placeChain(
            chain,
            chainReaction,
            reactionY,
            rX,
            eventColX + W,
            evtY + H / 2, // arrow always from event center
            ns,
            es,
            slice.name,
            sliceReactionByEvent,
            eventProjections,
            eventReactions,
            sliceRightXRef
          );
          // Advance watermark past all nodes placed by this chain
          for (let ni = chainStartIdx; ni < ns.length; ni++) {
            const n = ns[ni];
            const nh = n.type === "state" ? STATE_H : H;
            chainWatermark = Math.max(chainWatermark, n.pos.y + nh + GAP / 2);
          }
        }

        evtY += H + GAP / 2;
      }

      // ── Projections below events ──────────────────────────────
      const seenProj = new Set<string>();
      for (const me of measuredEvents) {
        const projs = eventProjections.get(me.eventName);
        if (!projs) continue;
        for (const pn of projs) {
          if (seenProj.has(pn)) continue;
          seenProj.add(pn);
          ns.push({
            key: `p:${pn}:${slice.name}`,
            pos: { x: eventColX, y: evtY },
            type: "projection",
            label: pn,
          });
          evtY += H + GAP / 2;
        }
      }

      sliceRightX = sliceRightXRef.value;

      // ── Actions centered relative to state ─────────────────────
      let actY = stCenterY - actBlockH / 2;
      const actionColors = [
        "#60a5fa",
        "#f97316",
        "#a78bfa",
        "#34d399",
        "#fb7185",
        "#fbbf24",
      ];
      let actionIdx = 0;
      for (const action of st.actions) {
        const color = actionColors[actionIdx % actionColors.length];
        ns.push({
          key: `a:${action.name}:${slice.name}`,
          pos: { x: cx, y: actY },
          type: "action",
          label: action.name,
          sub: action.invariants.length > 0 ? "guarded" : undefined,
          guards: action.invariants.length > 0 ? action.invariants : undefined,
          file: actionFileMap.get(action.name) ?? st.file,
        });
        for (const en of action.emits) {
          const ey = eventYMap.get(en)!;
          es.push({
            from: { x: cx + W, y: actY + H / 2 },
            to: { x: eventColX, y: ey + H / 2 },
            color,
            dash: false,
          });
        }
        actY += H + GAP / 2;
        actionIdx++;
      }

      // Advance y past projections and chain watermarks that may extend
      // beyond the primary action/state/event block
      const contentBottomY = Math.max(
        y + primaryBlockH,
        evtY,
        chainWatermark > -Infinity ? chainWatermark : 0
      );
      y = contentBottomY + GAP / 2;
      partIdx++;
    }

    // Remaining reactions not already placed inline (e.g., reactions on
    // events not declared in any state within this slice)
    for (const r of slice.reactions) {
      if (r.isVoid || visitedReactions.has(r.handlerName)) continue;

      const rX = sliceRightX + GAP * 2;
      const rp = { x: rX, y };
      ns.push({
        key: `r:${r.handlerName}:${slice.name}`,
        pos: rp,
        type: "reaction",
        label: r.handlerName,
      });

      sliceRightX = Math.max(sliceRightX, rX + W + GAP);
      y += H + GAP / 2;
    }

    // Compute bounding box from ALL nodes placed for this slice
    const bbox = {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    };
    for (let ni = sliceNodeStart; ni < ns.length; ni++) {
      const n = ns[ni];
      const nw = n.type === "state" ? STATE_W : W;
      const nh = n.type === "state" ? STATE_H : H;
      bbox.minX = Math.min(bbox.minX, n.pos.x);
      bbox.minY = Math.min(bbox.minY, n.pos.y);
      bbox.maxX = Math.max(bbox.maxX, n.pos.x + nw);
      bbox.maxY = Math.max(bbox.maxY, n.pos.y + nh);
    }
    // Fallback if no nodes were placed
    if (!isFinite(bbox.minY)) {
      bbox.minX = sx;
      bbox.minY = 0;
      bbox.maxX = sx + W;
      bbox.maxY = H;
    }
    // Phase 2: translate slice content to globalY
    const contentH = bbox.maxY - bbox.minY;
    const boxH = contentH + SLICE_INNER * 2;
    const dy = globalY - bbox.minY + SLICE_INNER;
    // Shift all nodes and edges placed for this slice
    for (let ni = sliceNodeStart; ni < ns.length; ni++) {
      ns[ni].pos.y += dy;
    }
    for (let ei = sliceEdgeStart; ei < es.length; ei++) {
      es[ei].from.y += dy;
      es[ei].to.y += dy;
    }
    boxes.push({
      label: slice.name,
      x: sx - GAP / 2,
      y: globalY,
      w: bbox.maxX - sx + GAP + SLICE_INNER,
      h: boxH,
      error: slice.error,
    });
    globalY += boxH + SLICE_GAP;
  }

  // Standalone states (not in slices) — stacked vertically like a virtual slice
  cx = PAD;
  const claimed = new Set(sortedSlices.flatMap((sl) => sl.stateVars));
  const standaloneStates = [...viewModel.states]
    .filter((s) => !claimed.has(s.varName))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const st of standaloneStates) {
    const stateColX = cx + W + GAP;
    const eventColX = stateColX + STATE_W + GAP;

    // Collect all events: from actions + declared in .emits() but not emitted by any action
    const actionEmittedEvents = new Set(st.actions.flatMap((a) => a.emits));
    const orphanEvents = st.events
      .map((e) => e.name)
      .filter((en) => !actionEmittedEvents.has(en));

    // Compute block sizes
    const nEvents = actionEmittedEvents.size + orphanEvents.length;
    const evtBlockH =
      Math.max(nEvents, 1) * H + (Math.max(nEvents, 1) - 1) * (GAP / 2);
    const nActs = st.actions.length;
    const actBlockH = nActs * H + (nActs - 1) * (GAP / 2);
    const blockH = Math.max(evtBlockH, actBlockH, STATE_H);
    const stCenterY = globalY + blockH / 2;

    // State (fixed square, vertically centered)
    ns.push({
      key: `s:${st.name}:standalone`,
      pos: { x: stateColX, y: stCenterY - STATE_H / 2 },
      type: "state",
      label: st.name,
    });

    // Events centered relative to state
    let evtY = stCenterY - evtBlockH / 2;
    const eventYMap = new Map<string, number>();
    for (const action of st.actions) {
      for (const en of action.emits) {
        ns.push({
          key: `e:${en}:standalone`,
          pos: { x: eventColX, y: evtY },
          type: "event",
          label: en,
          projections: eventProjections.get(en),
          reactions: eventReactions.get(en),
        });
        eventYMap.set(en, evtY);
        evtY += H + GAP / 2;
      }
    }
    // Orphan events — declared in .emits() but not produced by any action
    for (const en of orphanEvents) {
      ns.push({
        key: `e:${en}:standalone`,
        pos: { x: eventColX, y: evtY },
        type: "event",
        label: en,
        projections: eventProjections.get(en),
        reactions: eventReactions.get(en),
      });
      eventYMap.set(en, evtY);
      evtY += H + GAP / 2;
    }

    // Actions centered relative to state
    let actY = stCenterY - actBlockH / 2;
    const standaloneColors = [
      "#60a5fa",
      "#f97316",
      "#a78bfa",
      "#34d399",
      "#fb7185",
      "#fbbf24",
    ];
    let aIdx = 0;
    for (const action of st.actions) {
      const aColor = standaloneColors[aIdx % standaloneColors.length];
      ns.push({
        key: `a:${action.name}:standalone`,
        pos: { x: cx, y: actY },
        type: "action",
        label: action.name,
        sub: action.invariants.length > 0 ? "guarded" : undefined,
        guards: action.invariants.length > 0 ? action.invariants : undefined,
      });
      for (const en of action.emits) {
        const ey = eventYMap.get(en)!;
        es.push({
          from: { x: cx + W, y: actY + H / 2 },
          to: { x: eventColX, y: ey + H / 2 },
          color: aColor,
          dash: false,
        });
      }
      actY += H + GAP / 2;
      aIdx++;
    }

    globalY += blockH + GAP * 2;
  }

  // Standalone reactions (from act() builder, not in slices) — placed to the right of their events
  if (viewModel.reactions.length > 0) {
    const reactionYByEvent = new Map<string, number>();
    for (const r of viewModel.reactions) {
      if (r.isVoid) continue;
      // Find the event node this reaction listens to
      const trigNode = ns.find(
        (n) => n.type === "event" && n.label === r.event
      );
      const baseY = trigNode ? trigNode.pos.y : globalY;
      const rY = reactionYByEvent.get(r.event) ?? baseY;
      const rX = trigNode ? trigNode.pos.x + W + GAP * 3 : cx + W * 3 + GAP * 4;

      const rp = { x: rX, y: rY };
      ns.push({
        key: `r:${r.handlerName}:standalone`,
        pos: rp,
        type: "reaction",
        label: r.handlerName,
      });

      if (trigNode) {
        es.push({
          from: { x: trigNode.pos.x + W, y: trigNode.pos.y + H / 2 },
          to: { x: rp.x, y: rp.y + H / 2 },
          color: COLORS.reaction.border,
          dash: true,
        });
      }

      reactionYByEvent.set(r.event, rY + H + GAP / 2);
      globalY = Math.max(globalY, rY + H + GAP);
    }
  }

  let minX = 0,
    minY = 0,
    maxX = 0,
    maxY = 0;
  for (const n of ns) {
    const nw = n.type === "state" ? STATE_W : W;
    const nh = n.type === "state" ? STATE_H : H;
    minX = Math.min(minX, n.pos.x);
    minY = Math.min(minY, n.pos.y);
    maxX = Math.max(maxX, n.pos.x + nw);
    maxY = Math.max(maxY, n.pos.y + nh);
  }
  // Include boxes (error slices have no nodes but still need to be in bounds)
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return {
    ns,
    es,
    boxes,
    // Content bounds (used by viewBox to frame the diagram)
    minX: minX - MARGIN,
    minY: minY - MARGIN,
    width: maxX - minX + MARGIN * 2,
    height: maxY - minY + MARGIN * 2,
  };
}
