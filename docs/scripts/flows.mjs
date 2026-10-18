#!/usr/bin/env node
/**
 * Flow animations: renders docs/flows/*.flow.json into the docs site and
 * records them as video.
 *
 *   node scripts/flows.mjs build                       every spec -> static/flows/<name>.html + index.html
 *   node scripts/flows.mjs render <spec> <out.html> [--standalone]
 *   node scripts/flows.mjs video <name> [--scenario n] [--out file.mp4]
 *                                [--size 1920x1080] [--theme dark|light] [--speed 1]
 *
 * `build` runs before every docs build, so a spec merged to master is live on
 * the docs site after the next deploy. `render` without --standalone writes
 * page content for a claude.ai artifact, which adds its own document skeleton.
 * `video` drives Chrome through playwright-core, captures every frame the page
 * paints and encodes an H.264 MP4 with ffmpeg.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLOWS = join(DOCS, "flows");
const OUT = join(DOCS, "static", "flows");
const LANES = ["actor", "action", "state", "event", "projection", "reaction", "external"];

/** Returns the problems that make a spec unrenderable, and edges no scenario walks. */
export function validate(spec) {
  const problems = [];
  const ids = new Set();
  for (const n of spec.nodes ?? []) {
    if (ids.has(n.id)) problems.push(`duplicate node id ${n.id}`);
    ids.add(n.id);
    if (!LANES.includes(n.lane)) problems.push(`node ${n.id} has unknown lane ${n.lane}`);
  }
  const edge_keys = new Set();
  for (const e of spec.edges ?? []) {
    if (!ids.has(e.from)) problems.push(`edge from unknown node ${e.from}`);
    if (!ids.has(e.to)) problems.push(`edge to unknown node ${e.to}`);
    edge_keys.add(`${e.from}>${e.to}`);
  }
  const walked = new Set();
  for (const s of spec.scenarios ?? []) {
    (s.steps ?? []).forEach((st, i) => {
      if (st.at) {
        if (!ids.has(st.at)) problems.push(`scenario "${s.title}" step ${i + 1}: unknown node ${st.at}`);
        return;
      }
      const key = `${st.from}>${st.to}`;
      walked.add(key);
      if (!edge_keys.has(key)) problems.push(`scenario "${s.title}" step ${i + 1}: no edge ${st.from} -> ${st.to}`);
    });
  }
  const projections = new Set((spec.nodes ?? []).filter((n) => n.lane === "projection").map((n) => n.id));
  const unwalked = (spec.edges ?? [])
    .filter((e) => !projections.has(e.to) && !walked.has(`${e.from}>${e.to}`))
    .map((e) => `${e.from} -> ${e.to}`);
  return { problems, unwalked };
}

const esc_attr = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const wrap = (body, lang = "en") =>
  `<!doctype html>\n<html lang="${lang}">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

/** Renders a spec into the player. */
export function render(spec, { standalone = false } = {}) {
  const template = readFileSync(join(FLOWS, "player.html"), "utf8");
  const page = template
    .replace("__TITLE__", () => esc_attr(spec.title ?? "Act flow"))
    .replace("__DESCRIPTION__", () => esc_attr(spec.subtitle ?? ""))
    .replace("__FLOW_JSON__", () => JSON.stringify(spec).replace(/</g, "\\u003c"));
  return standalone ? wrap(page) : page;
}

function load_spec(path) {
  const spec = JSON.parse(readFileSync(path, "utf8"));
  spec.slug ??= basename(path).replace(/\.flow\.json$/, "");
  const { problems, unwalked } = validate(spec);
  if (problems.length) {
    console.error(`${basename(path)}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  if (unwalked.length) console.warn(`${basename(path)}: no scenario walks\n${unwalked.map((u) => `  - ${u}`).join("\n")}`);
  return spec;
}

function gallery(specs) {
  const cards = specs
    .map(
      (s) => `<a class="card" href="${esc_attr(s.slug)}.html">
      <span class="name">${esc_attr(s.title)}</span>
      <span class="desc">${esc_attr(s.subtitle)}</span>
      <span class="meta">${s.scenarios.length} scenarios · ${s.nodes.length} elements · ${esc_attr(s.source)}</span>
    </a>`
    )
    .join("\n");
  return wrap(`<title>Act Flow Animations</title>
<meta name="description" content="Animated maps of Act applications, generated from their builders.">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@600&family=IBM+Plex+Sans:wght@400;500&display=swap">
<style>
:root { --bg: #f4f5f8; --surface: #fff; --ink: #151922; --muted: #5d6574; --line: #dde1e8; --accent: #2b5fd0; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1015; --surface: #141920; --ink: #e8ebf1; --muted: #99a2b3; --line: #262d39; --accent: #6e9cff; color-scheme: dark; } }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 "IBM Plex Sans", system-ui, sans-serif; }
main { max-width: 960px; margin: 0 auto; padding-inline: 20px; padding-block: 48px; display: grid; gap: 24px; }
h1 { font: 600 32px/1.15 "IBM Plex Sans Condensed", system-ui, sans-serif; margin: 0; }
p { margin: 0; color: var(--muted); max-width: 64ch; }
a { color: var(--accent); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 14px; }
.card { display: grid; gap: 6px; padding: 18px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; text-decoration: none; color: var(--ink); }
.card:hover, .card:focus-visible { border-color: var(--accent); }
.name { font: 600 19px "IBM Plex Sans Condensed", system-ui, sans-serif; }
.desc { color: var(--muted); font-size: 14px; }
.meta { font: 12px "IBM Plex Mono", ui-monospace, monospace; color: var(--muted); }
</style>
<main>
  <h1>Act flow animations</h1>
  <p>Each map below is generated from an Act application's builders: every action, state check, event, projection, reaction and timer, with scenarios that play the flows step by step. <a href="../docs/guides/flow-animations">Make one for your app</a>.</p>
  <div class="grid">
${cards}
  </div>
</main>`);
}

function build() {
  mkdirSync(OUT, { recursive: true });
  const files = readdirSync(FLOWS).filter((f) => f.endsWith(".flow.json")).sort();
  const specs = files.map((f) => load_spec(join(FLOWS, f)));
  for (const spec of specs) writeFileSync(join(OUT, `${spec.slug}.html`), render(spec, { standalone: true }));
  writeFileSync(join(OUT, "index.html"), gallery(specs));
  console.log(`flows: ${specs.map((s) => s.slug).join(", ") || "none"} -> static/flows/`);
}

function arg(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}

async function video(args) {
  const name = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
  if (!name) throw new Error("usage: flows.mjs video <name> [--scenario n] [--out file.mp4]");
  const spec = load_spec(join(FLOWS, `${name}.flow.json`));
  const [width, height] = arg(args, "size", "1920x1080").split("x").map(Number);
  const scenario = arg(args, "scenario");
  const theme = arg(args, "theme", "dark");
  const speed = arg(args, "speed", "1");
  const out = resolve(arg(args, "out", `${name}${scenario ? "-" + scenario : ""}.mp4`));
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });

  const work = mkdtempSync(join(tmpdir(), "act-flow-"));
  const page_path = join(work, "page.html");
  writeFileSync(page_path, render(spec, { standalone: true }));
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ channel: arg(args, "channel", "chrome") });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const cdp = await page.context().newCDPSession(page);
    const frames = [];
    cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
      const file = join(work, `f${String(frames.length).padStart(6, "0")}.jpg`);
      writeFileSync(file, Buffer.from(data, "base64"));
      frames.push({ file, t: metadata.timestamp });
      await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });
    const hash = ["record", theme, scenario ? `s${scenario}` : ""].filter(Boolean).join("-");
    await page.goto(`${pathToFileURL(page_path)}?speed=${speed}#${hash}`);
    await page.evaluate(() => document.fonts.ready);
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: width, maxHeight: height });
    await page.waitForFunction(() => document.documentElement.dataset.done === "1", null, { timeout: 30 * 60_000, polling: 500 });
    await page.waitForTimeout(800);
    await cdp.send("Page.stopScreencast");
    if (!frames.length) throw new Error("no frames captured");
    // the screencast only sends changed frames; hold each one until the next
    const list = frames
      .map((f, i) => `file '${f.file}'\nduration ${Math.max(1 / 60, (frames[i + 1]?.t ?? f.t + 1) - f.t).toFixed(4)}`)
      .join("\n");
    writeFileSync(join(work, "frames.txt"), `${list}\nfile '${frames.at(-1).file}'\n`);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(work, "frames.txt"),
      "-vf", `fps=30,scale=${width}:${height}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "18",
      "-movflags", "+faststart", out], { stdio: "inherit" });
    console.log(`video: ${out} (${frames.length} frames, ${(frames.at(-1).t - frames[0].t).toFixed(1)} s)`);
  } finally {
    await browser.close();
    rmSync(work, { recursive: true, force: true });
  }
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "build") build();
else if (cmd === "render") {
  const [input, output] = args.filter((a) => !a.startsWith("--"));
  if (!input || !output) throw new Error("usage: flows.mjs render <spec> <out.html> [--standalone]");
  writeFileSync(output, render(load_spec(resolve(input)), { standalone: args.includes("--standalone") }));
  console.log(`wrote ${output}`);
} else if (cmd === "video") await video(args);
else if (cmd && existsSync(cmd)) throw new Error(`unknown command; did you mean: render ${cmd} <out.html>`);
else {
  console.error("usage: flows.mjs build | render <spec> <out.html> [--standalone] | video <name> [options]");
  process.exit(1);
}
