/**
 * Reads an Act project and prints a draft flow spec (JSON) for the player.
 *
 *   npx tsx .claude/skills/animate-act-flows/scripts/extract.mts <dir> > flow.json
 *
 * Reuses the act-diagram parser, so it sees what `pnpm act` sees: states,
 * actions (with invariants and emitted events), slices, reactions (with the
 * actions they invoke through `app.do`) and projections. The draft is a
 * starting point. The parser is best-effort, so the skill asks you to read the
 * source and fill what it misses (actions invoked inside helpers, webhooks, timers,
 * lanes, actors) before writing scenarios.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(import.meta.url), "../../../../..");
const { load_project } = await import(
  `${root}/libs/act-diagram/src/cli/load-project.ts`
);
const { extract_model } = await import(
  `${root}/libs/act-diagram/src/client/lib/evaluate.ts`
);

const dir = process.argv[2];
if (!dir) {
  console.error("usage: extract.mts <project-dir>");
  process.exit(1);
}
const { files } = await load_project(resolve(dir));
const { model, error } = extract_model(files);
if (error) console.error(`parser: ${error}`);

type Node = Record<string, unknown> & { id: string; lane: string; label: string };
const nodes = new Map<string, Node>();
const edges: { from: string; to: string; label?: string }[] = [];
const edge = (from: string, to: string, label?: string) => {
  if (!edges.some((e) => e.from === from && e.to === to))
    edges.push(label ? { from, to, label } : { from, to });
};

// actions and events, merged across partial states that share a name
const emits = new Map<string, string[]>();
for (const s of model.states) {
  for (const a of s.actions) {
    nodes.set(`action:${a.name}`, {
      id: `action:${a.name}`,
      lane: "action",
      label: a.name,
      state: s.name,
      invariants: a.invariants,
      ...(a.preconditions?.length ? { preconditions: a.preconditions } : {}),
      ...(s.file ? { file: s.file, line: a.line } : {}),
    });
    emits.set(a.name, a.emits);
  }
  for (const e of s.events) {
    nodes.set(`evt:${e.name}`, {
      id: `evt:${e.name}`,
      lane: "event",
      label: e.name,
      state: s.name,
      ...(e.schema ? { schema: e.schema } : {}),
      ...(s.file ? { file: s.file, line: e.line } : {}),
    });
  }
}
for (const [a, evs] of emits)
  for (const e of evs) edge(`action:${a}`, `evt:${e}`, "emits");

// reactions, keyed by handler + trigger so shared names stay apart
const reactions = [
  ...model.reactions,
  ...model.slices.flatMap((s: { reactions: unknown[] }) => s.reactions),
] as { event: string; handlerName: string; dispatches: string[]; file?: string; line?: number }[];
for (const r of reactions) {
  const id = `reaction:${r.handlerName}:${r.event}`;
  if (nodes.has(id)) continue;
  nodes.set(id, {
    id,
    lane: "reaction",
    label: r.handlerName,
    ...(r.file ? { file: r.file, line: r.line } : {}),
  });
  edge(`evt:${r.event}`, id, "triggers");
  for (const d of r.dispatches) edge(id, `action:${d}`, "invokes");
}

// projections become bars fed by the events they handle
for (const p of model.projections) {
  const id = `proj:${p.name}`;
  nodes.set(id, { id, lane: "projection", label: p.name, ...(p.file ? { file: p.file } : {}) });
  for (const e of p.handles) edge(`evt:${e}`, id, "projects");
}

// order columns by causality: entry actions first, then whatever they set off
const invoked = new Set(edges.filter((e) => e.label === "invokes").map((e) => e.to));
const out = (id: string) => edges.filter((e) => e.from === id).map((e) => e.to);
const order: string[] = [];
const visit = (id: string) => {
  if (order.includes(id)) return;
  order.push(id);
  for (const evt of out(id))
    for (const reaction of out(evt).filter((n) => n.startsWith("reaction:")))
      for (const action of out(reaction)) visit(action);
};
const actions = [...nodes.keys()].filter((k) => k.startsWith("action:"));
for (const c of actions.filter((c) => !invoked.has(c))) visit(c);
for (const c of actions) visit(c);
order.forEach((c, i) => {
  nodes.get(c)!.col = i;
  out(c).forEach((evt, j, all) => {
    const n = nodes.get(evt);
    if (n && n.col === undefined) n.col = i + (j - (all.length - 1) / 2) * 0.9;
  });
});
for (const n of nodes.values()) {
  if (n.lane !== "reaction") continue;
  const trigger = edges.find((e) => e.to === n.id)!.from;
  const siblings = edges.filter((e) => e.from === trigger && e.to.startsWith("reaction:"));
  const k = siblings.findIndex((e) => e.to === n.id);
  n.col = ((nodes.get(trigger)?.col as number) ?? 0) + (k - (siblings.length - 1) / 2) * 0.9;
}

// one state bar per state name, listing the partials merged into it
const partials = new Map<string, Set<string>>();
for (const s of model.states)
  (partials.get(s.name) ?? partials.set(s.name, new Set()).get(s.name)!).add(s.file ?? s.varName);
for (const [name, files] of partials)
  nodes.set(`state:${name}`, { id: `state:${name}`, lane: "state", label: name, note: `${files.size} partial state(s)` });

// slices own the partial states declared in their own file, plus the reactions they declare;
// the other partials they register are references
type Slice = { name: string; stateVars: string[]; reactions: { event: string; handlerName: string }[]; file?: string; line?: number };
const by_var = new Map(model.states.map((s: { varName: string }) => [s.varName, s]));
const slices = (model.slices as Slice[]).map((sl) => {
  const registers = sl.stateVars.filter((v) => by_var.has(v));
  const owns = registers.filter((v) => sl.file && (by_var.get(v) as { file?: string }).file === sl.file);
  const id = `slice:${sl.name}`;
  for (const v of owns) {
    const s = by_var.get(v) as { actions: { name: string }[]; events: { name: string }[] };
    for (const a of s.actions) nodes.get(`action:${a.name}`)!.slice = id;
    for (const e of s.events) nodes.get(`evt:${e.name}`)!.slice = id;
  }
  for (const r of sl.reactions) {
    const n = nodes.get(`reaction:${r.handlerName}:${r.event}`);
    if (n) n.slice = id;
  }
  // the parser names partials "Ticket:0"; the file says which one it is
  const partial = (v: string) => {
    const s = by_var.get(v) as { name: string; file?: string };
    return s.file ? `${s.name} (${s.file.split("/").pop()})` : v;
  };
  return { id, label: sl.name, owns: owns.map(partial), registers: registers.map(partial), ...(sl.file ? { file: sl.file, line: sl.line } : {}) };
});

const spec = {
  title: "Act flow",
  subtitle: "",
  source: dir,
  ...(slices.length ? { slices } : {}),
  lanes: [
    { id: "actor", label: "Actors" },
    { id: "action", label: "Actions" },
    { id: "state", label: "State", sub: "load · check · patch" },
    { id: "event", label: "Events" },
    { id: "projection", label: "Projections" },
    { id: "reaction", label: "Reactions" },
    { id: "external", label: "Outside world" },
  ],
  nodes: [...nodes.values()],
  edges,
  scenarios: [],
};
console.log(JSON.stringify(spec, null, 2));
