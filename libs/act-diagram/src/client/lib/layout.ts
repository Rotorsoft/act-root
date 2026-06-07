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
  /** Best-effort Zod source text for event nodes (see EventNode.schema). */
  schema?: string;
  /** Events this action emits — shown in action-node tooltips. */
  emits?: string[];
  /** Events this projection handles — shown in projection-node tooltips. */
  handles?: string[];
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
};

type EmitMeasure = {
  name: string;
  h: number; // H if no sub-chain, or sub-chain groupH if it has one
  sub_chain?: ChainMeasure;
  sub_reaction?: ReactionDef;
};
type RowMeasure = {
  an: string;
  rowH: number;
  emit_infos: EmitMeasure[];
  emitsH: number;
  target_state: StateNode | undefined;
};
type ChainMeasure = {
  groupH: number;
  dispatch_block_h: number;
  rows: RowMeasure[];
};

/** Measure a reaction chain recursively (leaves first) */
function measure_chain(
  rDef: ReactionDef,
  lookup: Map<string, ReactionDef>,
  visited: Set<string>,
  all_states: StateNode[]
): ChainMeasure {
  const rows: RowMeasure[] = [];
  let dispatch_block_h = 0;

  for (const an of rDef.dispatches) {
    const target_action = all_states
      .flatMap((s) => s.actions)
      .find((a) => a.name === an);
    const target_state = all_states.find((s) =>
      s.actions.some((a) => a.name === an)
    );
    const emit_names = target_action?.emits ?? [];

    const emit_infos: EmitMeasure[] = [];
    let emitsH = 0;
    for (const en of emit_names) {
      const subR = lookup.get(en);
      let eventH = H;
      let sub_chain: ChainMeasure | undefined;
      if (subR && !visited.has(subR.handlerName)) {
        visited.add(subR.handlerName);
        sub_chain = measure_chain(subR, lookup, visited, all_states);
        eventH = Math.max(H, sub_chain.groupH);
      }
      emit_infos.push({
        name: en,
        h: eventH,
        sub_chain,
        sub_reaction: subR && sub_chain ? subR : undefined,
      });
      emitsH += eventH;
    }

    const rowH = Math.max(H, target_state ? STATE_H : 0, emitsH || H);
    rows.push({ an, rowH, emit_infos, emitsH, target_state });
    if (dispatch_block_h > 0) dispatch_block_h += GAP / 2;
    dispatch_block_h += rowH;
  }

  return { groupH: Math.max(H, dispatch_block_h), dispatch_block_h, rows };
}

/**
 * Place a reaction chain recursively.
 * The reaction aligns with the triggering event (reactionY).
 * The dispatched block is centered relative to the reaction.
 */
function place_chain(
  measure: ChainMeasure,
  rDef: ReactionDef,
  reactionY: number,
  rX: number,
  triggered_from_x: number,
  triggered_from_y: number,
  ns: N[],
  es: E[],
  slice_name: string,
  lookup: Map<string, ReactionDef>,
  event_projections: Map<string, string[]>,
  event_reactions: Map<string, string[]>,
  event_schemas: Map<string, string>,
  slice_right_x_ref: { value: number }
): void {
  const dispatch_base_x = rX + W + GAP;

  // Reaction node — aligned with triggering event
  const rp = { x: rX, y: reactionY };
  ns.push({
    key: `r:${rDef.handlerName}:${slice_name}`,
    pos: rp,
    type: "reaction",
    label: rDef.handlerName,
  });
  es.push({
    from: { x: triggered_from_x, y: triggered_from_y },
    to: { x: rp.x, y: rp.y + H / 2 },
    color: COLORS.reaction.border,
    dash: true,
  });

  // Dispatched rows — centered vertically relative to reaction center
  const reaction_center_y = reactionY + H / 2;
  let dispatchY = reaction_center_y - measure.dispatch_block_h / 2;

  for (const row of measure.rows) {
    const row_center_y = dispatchY + row.rowH / 2;
    let nextX = dispatch_base_x;

    // Dispatched action — centered in row
    const dap = { x: nextX, y: row_center_y - H / 2 };
    const dispatched_action = row.target_state?.actions.find(
      (a) => a.name === row.an
    );
    ns.push({
      key: `a:${row.an}:dispatched:${rDef.handlerName}`,
      pos: dap,
      type: "action",
      label: row.an,
      sub:
        dispatched_action && dispatched_action.invariants.length > 0
          ? "guarded"
          : undefined,
      guards:
        dispatched_action && dispatched_action.invariants.length > 0
          ? dispatched_action.invariants
          : undefined,
      file: row.target_state?.file,
      emits: dispatched_action?.emits,
    });
    es.push({
      from: { x: rp.x + W, y: rp.y + H / 2 },
      to: { x: dap.x, y: dap.y + H / 2 },
      color: COLORS.reaction.border,
      dash: true,
    });
    nextX += W + GAP;

    // Dispatched state — centered in row
    if (row.target_state) {
      ns.push({
        key: `s:${row.target_state.name}:dispatched:${rDef.handlerName}:${row.an}`,
        pos: { x: nextX, y: row_center_y - STATE_H / 2 },
        type: "state",
        label: row.target_state.name,
        file: row.target_state.file,
      });
      nextX += STATE_W + GAP;
    }

    // Dispatched events — vertically centered with the state box,
    // each event node is H tall; sub-chains extend rightward
    const evtX = nextX;
    const nEvents = row.emit_infos.length;
    const events_only_h = nEvents * H + (nEvents - 1) * (GAP / 2);
    let emitY = row_center_y - events_only_h / 2;
    for (const emit of row.emit_infos) {
      ns.push({
        key: `e:${emit.name}:dispatched:${rDef.handlerName}:${row.an}`,
        pos: { x: evtX, y: emitY },
        type: "event",
        label: emit.name,
        file: row.target_state?.file,
        projections: event_projections.get(emit.name),
        reactions: event_reactions.get(emit.name),
        schema: event_schemas.get(emit.name),
      });

      // Recurse into sub-chain — reaction aligns with this emit
      if (emit.sub_chain && emit.sub_reaction) {
        const sub_r_x = evtX + W + GAP * 3;
        place_chain(
          emit.sub_chain,
          emit.sub_reaction,
          emitY, // reaction aligns with emit
          sub_r_x,
          evtX + W,
          emitY + H / 2,
          ns,
          es,
          slice_name,
          lookup,
          event_projections,
          event_reactions,
          event_schemas,
          slice_right_x_ref
        );
      }

      emitY += H + GAP / 2;
    }
    if (row.emit_infos.length > 0) nextX = evtX + W + GAP;
    slice_right_x_ref.value = Math.max(slice_right_x_ref.value, nextX);
    dispatchY += row.rowH + GAP / 2;
  }
}

// ── Layout computation ───────────────────────────────────────────────
export function compute_layout(view_model: DomainModel): Layout {
  const ns: N[] = [];
  const es: E[] = [];
  const boxes: Box[] = [];
  const sv = new Map<string, StateNode>();
  for (const s of view_model.states) {
    sv.set(s.varName, s);
    sv.set(s.name, s);
  }

  // Build projection lookup: event name → projection names
  const event_projections = new Map<string, string[]>();
  const event_reactions = new Map<string, string[]>();
  // Captured Zod schema text per event name (first occurrence wins).
  const event_schemas = new Map<string, string>();
  for (const s of view_model.states) {
    for (const e of s.events) {
      if (e.schema && !event_schemas.has(e.name)) {
        event_schemas.set(e.name, e.schema);
      }
    }
  }
  // Projection name → event names it handles (for projection tooltips).
  const projection_handles = new Map<string, string[]>();
  for (const proj of view_model.projections) {
    projection_handles.set(proj.name, proj.handles);
  }

  for (const slice of view_model.slices) {
    for (const r of slice.reactions) {
      const list = event_reactions.get(r.event) ?? [];
      list.push(r.handlerName);
      event_reactions.set(r.event, list);
    }
  }
  for (const r of view_model.reactions) {
    const list = event_reactions.get(r.event) ?? [];
    list.push(r.handlerName);
    event_reactions.set(r.event, list);
  }
  for (const proj of view_model.projections) {
    for (const en of proj.handles) {
      const list = event_projections.get(en) ?? [];
      list.push(proj.name);
      event_projections.set(en, list);
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
  const sorted_slices = [...view_model.slices].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const slice of sorted_slices) {
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
    const event_file_map = new Map<string, string>();
    const action_file_map = new Map<string, string>();
    const raw_parts = slice.stateVars
      .map((v) => sv.get(v))
      .filter(Boolean) as StateNode[];
    const merged_by_name = new Map<string, StateNode>();
    for (const st of raw_parts) {
      // Record source file for each event and action
      for (const e of st.events) {
        if (st.file) event_file_map.set(e.name, st.file);
      }
      for (const a of st.actions) {
        if (st.file) action_file_map.set(a.name, st.file);
      }
      const existing = merged_by_name.get(st.name);
      if (existing) {
        // Merge actions and events, avoiding duplicates
        const action_names = new Set(existing.actions.map((a) => a.name));
        for (const a of st.actions) {
          if (!action_names.has(a.name)) existing.actions.push(a);
        }
        const event_names = new Set(existing.events.map((e) => e.name));
        for (const e of st.events) {
          if (!event_names.has(e.name)) existing.events.push(e);
        }
      } else {
        // Clone so we don't mutate the original
        merged_by_name.set(st.name, {
          ...st,
          actions: [...st.actions],
          events: [...st.events],
        });
      }
    }
    const parts = [...merged_by_name.values()];

    let y = SLICE_INNER; // layout relative to y=0
    let slice_right_x = cx;
    const slice_node_start = ns.length;
    const slice_edge_start = es.length;

    // Build event→reactions lookup within this slice (supports multiple per event)
    const slice_reactions_by_event = new Map<string, typeof slice.reactions>();
    for (const r of slice.reactions) {
      const list = slice_reactions_by_event.get(r.event) ?? [];
      list.push(r);
      slice_reactions_by_event.set(r.event, list);
    }
    // Single-reaction lookup for chain measurement (uses first reaction)
    const slice_reaction_by_event = new Map<
      string,
      (typeof slice.reactions)[0]
    >();
    for (const [event, reactions] of slice_reactions_by_event) {
      slice_reaction_by_event.set(event, reactions[0]);
    }

    // Track visited events/reactions to prevent cycles
    const visited_events = new Set<string>();
    const visited_reactions = new Set<string>();

    let part_idx = 0;
    for (const st of parts) {
      // Extra vertical separation between states within a slice
      if (part_idx > 0) y += GAP * 2;
      const state_col_x = cx + W + GAP;
      const event_col_x = state_col_x + STATE_W + GAP;

      // ── Pre-calculate sizes ────────────────────────────────────
      const event_rows: { event_name: string; action_name: string }[] = [];
      const action_emitted = new Set<string>();
      for (const action of st.actions) {
        for (const en of action.emits) {
          action_emitted.add(en);
        }
      }
      // Trigger events first (declared in .emits() but not produced by any
      // action) — these are chain entry points and must be processed before
      // their downstream events so the full serial chain is detected
      for (const ev of st.events) {
        if (!action_emitted.has(ev.name)) {
          event_rows.push({ event_name: ev.name, action_name: "" });
        }
      }
      for (const action of st.actions) {
        for (const en of action.emits) {
          event_rows.push({ event_name: en, action_name: action.name });
        }
      }
      // ── Measure per-event heights (including sub-chains) ─────
      type EventMeasure = {
        event_name: string;
        action_name: string;
        h: number;
        chains: Array<{ chain: ChainMeasure; reaction: ReactionDef }>;
      };
      const measured_events: EventMeasure[] = [];
      let evt_block_h = 0;
      for (const { event_name: en, action_name } of event_rows) {
        const chains: Array<{ chain: ChainMeasure; reaction: ReactionDef }> =
          [];
        if (!visited_events.has(en)) {
          const rDefs = slice_reactions_by_event.get(en) ?? [];
          for (const rDef of rDefs) {
            if (visited_reactions.has(rDef.handlerName)) continue;
            visited_reactions.add(rDef.handlerName);
            const chain = measure_chain(
              rDef,
              slice_reaction_by_event,
              visited_reactions,
              view_model.states
            );
            chains.push({ chain, reaction: rDef });
          }
          if (rDefs.length > 0) visited_events.add(en);
        }
        measured_events.push({
          event_name: en,
          action_name,
          h: H,
          chains,
        });
        if (evt_block_h > 0) evt_block_h += GAP / 2;
        // Primary event always claims H in the event column —
        // chain height extends rightward, not downward
        evt_block_h += H;
      }
      if (evt_block_h === 0) evt_block_h = H;

      const nActs = st.actions.length;
      const act_block_h = nActs * H + (nActs - 1) * (GAP / 2);
      const primary_block_h = Math.max(evt_block_h, act_block_h, STATE_H);
      const st_center_y = y + primary_block_h / 2;

      // ── State box (fixed square, vertically centered) ─────────
      ns.push({
        key: `s:${st.name}:${slice.name}`,
        pos: { x: state_col_x, y: st_center_y - STATE_H / 2 },
        type: "state",
        label: st.name,
        file: st.file,
      });

      // ── Events centered, chains extend right with watermark ────
      const slice_right_x_ref = { value: slice_right_x };
      let evtY = st_center_y - evt_block_h / 2;
      let chain_watermark = -Infinity; // tracks lowest Y used by chains
      const event_y_map = new Map<string, number>();

      for (let ei = 0; ei < measured_events.length; ei++) {
        const { event_name: en, action_name, chains } = measured_events[ei];
        ns.push({
          key: `e:${en}:${slice.name}:${action_name}`,
          pos: { x: event_col_x, y: evtY },
          type: "event",
          label: en,
          file: event_file_map.get(en) ?? st.file,
          projections: event_projections.get(en),
          reactions: event_reactions.get(en),
          schema: event_schemas.get(en),
        });
        event_y_map.set(en, evtY);

        // Place all reaction chains for this event — each aligns with
        // the event when possible, pushed down by watermark when
        // previous chains need space
        for (const { chain, reaction: chain_reaction } of chains) {
          const rX = event_col_x + W + GAP * 3;
          // Reaction must be placed so its dispatched block doesn't
          // overlap previous chains. The block extends dispatch_block_h/2
          // above the reaction center, so:
          //   reaction_center - dispatch_block_h/2 >= chain_watermark
          //   reactionY + H/2 - dispatch_block_h/2 >= chain_watermark
          //   reactionY >= chain_watermark - H/2 + dispatch_block_h/2
          const min_reaction_y =
            chain_watermark + chain.dispatch_block_h / 2 - H / 2;
          const reactionY = Math.max(evtY, min_reaction_y);
          const chain_start_idx = ns.length;
          place_chain(
            chain,
            chain_reaction,
            reactionY,
            rX,
            event_col_x + W,
            evtY + H / 2, // arrow always from event center
            ns,
            es,
            slice.name,
            slice_reaction_by_event,
            event_projections,
            event_reactions,
            event_schemas,
            slice_right_x_ref
          );
          // Advance watermark past all nodes placed by this chain
          for (let ni = chain_start_idx; ni < ns.length; ni++) {
            const n = ns[ni];
            const nh = n.type === "state" ? STATE_H : H;
            chain_watermark = Math.max(chain_watermark, n.pos.y + nh + GAP / 2);
          }
        }

        evtY += H + GAP / 2;
      }

      // ── Projections below events ──────────────────────────────
      const seen_proj = new Set<string>();
      for (const me of measured_events) {
        const projs = event_projections.get(me.event_name);
        if (!projs) continue;
        for (const pn of projs) {
          if (seen_proj.has(pn)) continue;
          seen_proj.add(pn);
          ns.push({
            key: `p:${pn}:${slice.name}`,
            pos: { x: event_col_x, y: evtY },
            type: "projection",
            label: pn,
            handles: projection_handles.get(pn),
          });
          evtY += H + GAP / 2;
        }
      }

      slice_right_x = slice_right_x_ref.value;

      // ── Actions centered relative to state ─────────────────────
      let actY = st_center_y - act_block_h / 2;
      const action_colors = [
        "#60a5fa",
        "#f97316",
        "#a78bfa",
        "#34d399",
        "#fb7185",
        "#fbbf24",
      ];
      let action_idx = 0;
      for (const action of st.actions) {
        const color = action_colors[action_idx % action_colors.length];
        ns.push({
          key: `a:${action.name}:${slice.name}`,
          pos: { x: cx, y: actY },
          type: "action",
          label: action.name,
          sub: action.invariants.length > 0 ? "guarded" : undefined,
          guards: action.invariants.length > 0 ? action.invariants : undefined,
          file: action_file_map.get(action.name) ?? st.file,
          emits: action.emits,
        });
        for (const en of action.emits) {
          const ey = event_y_map.get(en)!;
          es.push({
            from: { x: cx + W, y: actY + H / 2 },
            to: { x: event_col_x, y: ey + H / 2 },
            color,
            dash: false,
          });
        }
        actY += H + GAP / 2;
        action_idx++;
      }

      // Advance y past projections and chain watermarks that may extend
      // beyond the primary action/state/event block
      const content_bottom_y = Math.max(
        y + primary_block_h,
        evtY,
        chain_watermark > -Infinity ? chain_watermark : 0
      );
      y = content_bottom_y + GAP / 2;
      part_idx++;
    }

    // Remaining reactions not already placed inline (e.g., reactions on
    // events not declared in any state within this slice)
    for (const r of slice.reactions) {
      if (visited_reactions.has(r.handlerName)) continue;

      const rX = slice_right_x + GAP * 2;
      const rp = { x: rX, y };
      ns.push({
        key: `r:${r.handlerName}:${slice.name}`,
        pos: rp,
        type: "reaction",
        label: r.handlerName,
      });

      slice_right_x = Math.max(slice_right_x, rX + W + GAP);
      y += H + GAP / 2;
    }

    // Compute bounding box from ALL nodes placed for this slice
    const bbox = {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    };
    for (let ni = slice_node_start; ni < ns.length; ni++) {
      const n = ns[ni];
      const nw = n.type === "state" ? STATE_W : W;
      const nh = n.type === "state" ? STATE_H : H;
      bbox.minX = Math.min(bbox.minX, n.pos.x);
      bbox.minY = Math.min(bbox.minY, n.pos.y);
      bbox.maxX = Math.max(bbox.maxX, n.pos.x + nw);
      bbox.maxY = Math.max(bbox.maxY, n.pos.y + nh);
    }
    // Fallback if no nodes were placed
    if (!Number.isFinite(bbox.minY)) {
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
    for (let ni = slice_node_start; ni < ns.length; ni++) {
      ns[ni].pos.y += dy;
    }
    for (let ei = slice_edge_start; ei < es.length; ei++) {
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
  const claimed = new Set(sorted_slices.flatMap((sl) => sl.stateVars));
  const standalone_states = [...view_model.states]
    .filter((s) => !claimed.has(s.varName))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const st of standalone_states) {
    const state_col_x = cx + W + GAP;
    const event_col_x = state_col_x + STATE_W + GAP;

    // Collect all events: from actions + declared in .emits() but not emitted by any action
    const action_emitted_events = new Set(st.actions.flatMap((a) => a.emits));
    const orphan_events = st.events
      .map((e) => e.name)
      .filter((en) => !action_emitted_events.has(en));

    // Compute block sizes
    const nEvents = action_emitted_events.size + orphan_events.length;
    const evt_block_h =
      Math.max(nEvents, 1) * H + (Math.max(nEvents, 1) - 1) * (GAP / 2);
    const nActs = st.actions.length;
    const act_block_h = nActs * H + (nActs - 1) * (GAP / 2);
    const blockH = Math.max(evt_block_h, act_block_h, STATE_H);
    const st_center_y = globalY + blockH / 2;

    // State (fixed square, vertically centered)
    ns.push({
      key: `s:${st.name}:standalone`,
      pos: { x: state_col_x, y: st_center_y - STATE_H / 2 },
      type: "state",
      label: st.name,
    });

    // Events centered relative to state
    let evtY = st_center_y - evt_block_h / 2;
    const event_y_map = new Map<string, number>();
    for (const action of st.actions) {
      for (const en of action.emits) {
        ns.push({
          key: `e:${en}:standalone`,
          pos: { x: event_col_x, y: evtY },
          type: "event",
          label: en,
          projections: event_projections.get(en),
          reactions: event_reactions.get(en),
          schema: event_schemas.get(en),
        });
        event_y_map.set(en, evtY);
        evtY += H + GAP / 2;
      }
    }
    // Orphan events — declared in .emits() but not produced by any action
    for (const en of orphan_events) {
      ns.push({
        key: `e:${en}:standalone`,
        pos: { x: event_col_x, y: evtY },
        type: "event",
        label: en,
        projections: event_projections.get(en),
        reactions: event_reactions.get(en),
        schema: event_schemas.get(en),
      });
      event_y_map.set(en, evtY);
      evtY += H + GAP / 2;
    }

    // Actions centered relative to state
    let actY = st_center_y - act_block_h / 2;
    const standalone_colors = [
      "#60a5fa",
      "#f97316",
      "#a78bfa",
      "#34d399",
      "#fb7185",
      "#fbbf24",
    ];
    let aIdx = 0;
    for (const action of st.actions) {
      const aColor = standalone_colors[aIdx % standalone_colors.length];
      ns.push({
        key: `a:${action.name}:standalone`,
        pos: { x: cx, y: actY },
        type: "action",
        label: action.name,
        sub: action.invariants.length > 0 ? "guarded" : undefined,
        guards: action.invariants.length > 0 ? action.invariants : undefined,
        emits: action.emits,
      });
      for (const en of action.emits) {
        const ey = event_y_map.get(en)!;
        es.push({
          from: { x: cx + W, y: actY + H / 2 },
          to: { x: event_col_x, y: ey + H / 2 },
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
  if (view_model.reactions.length > 0) {
    const reaction_y_by_event = new Map<string, number>();
    for (const r of view_model.reactions) {
      // Find the event node this reaction listens to
      const trig_node = ns.find(
        (n) => n.type === "event" && n.label === r.event
      );
      const baseY = trig_node ? trig_node.pos.y : globalY;
      const rY = reaction_y_by_event.get(r.event) ?? baseY;
      const rX = trig_node
        ? trig_node.pos.x + W + GAP * 3
        : cx + W * 3 + GAP * 4;

      const rp = { x: rX, y: rY };
      ns.push({
        key: `r:${r.handlerName}:standalone`,
        pos: rp,
        type: "reaction",
        label: r.handlerName,
      });

      if (trig_node) {
        es.push({
          from: { x: trig_node.pos.x + W, y: trig_node.pos.y + H / 2 },
          to: { x: rp.x, y: rp.y + H / 2 },
          color: COLORS.reaction.border,
          dash: true,
        });
      }

      reaction_y_by_event.set(r.event, rY + H + GAP / 2);
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
