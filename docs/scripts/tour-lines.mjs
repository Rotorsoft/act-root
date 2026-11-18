#!/usr/bin/env node
/**
 * Writes src/tours/framework-tour.voice.json: every sentence the tour's narrator says,
 * one entry per caption sentence of every step plus one per chapter title card,
 * as [{ key, text }]. The key is the first 12 hex digits of the text's sha1, so
 * a renderer only needs to make clips for new or edited lines. The page bundles
 * the file and plays static/tour/voice/<key>.m4a for each line.
 *
 *   node scripts/tour-lines.mjs           (from docs/, Node with type stripping)
 *   node scripts/tour-lines.mjs --check   fails when the file is stale or a line has no clip
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { default: spec } = await import(join(here, "../src/tours/framework-tour.ts"));
const { frames, step_speech, card_speech } = await import(join(here, "../src/components/Tour/world.ts"));

const key = (text) => createHash("sha1").update(text).digest("hex").slice(0, 12);
const all = frames(spec);
// an intro chapter is chapter 0, as the player numbers it
const first = spec.chapters[0]?.id === "intro" ? 0 : 1;
const lines = new Map();
for (const f of all) {
  const step = spec.chapters[f.chapter].scenes[f.scene].steps[f.step];
  for (const text of step_speech(step, f.world, all.base)) lines.set(text, key(text));
}
for (const [i, c] of spec.chapters.entries()) {
  const text = card_speech(i + first, c.title);
  lines.set(text, key(text));
}

const out = join(here, "../src/tours/framework-tour.voice.json");
const clips = join(here, "../static/tour/voice");
const rows = [...lines].map(([text, k]) => ({ key: k, text }));
const json = `${JSON.stringify(rows, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const problems = [];
  if (!existsSync(out) || readFileSync(out, "utf8") !== json) problems.push(`${out} is stale: run pnpm -F docs tour:lines`);
  for (const { key: k, text } of rows)
    if (!existsSync(join(clips, `${k}.m4a`))) problems.push(`no clip ${k}.m4a for "${text}": render it with scripts/tour-voice.py`);
  for (const p of problems) console.error(p);
  process.exit(problems.length ? 1 : 0);
}
writeFileSync(out, json);
console.log(`${rows.length} lines → ${out}`);
