#!/usr/bin/env node
/**
 * Writes static/tour/voice/lines.json: every sentence the tour's narrator says,
 * one entry per caption sentence of every step plus one per chapter title card,
 * as [{ key, text }]. The key is the first 12 hex digits of the text's sha1, so
 * a renderer only needs to make clips for new or edited lines: the player plays
 * static/tour/voice/<key>.m4a when it exists and falls back to the browser's
 * voice when it doesn't.
 *
 *   node scripts/tour-lines.mjs        (from docs/, Node with type stripping)
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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

const out = join(here, "../static/tour/voice/lines.json");
mkdirSync(dirname(out), { recursive: true });
const rows = [...lines].map(([text, k]) => ({ key: k, text }));
writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`);
console.log(`${rows.length} lines → ${out}`);
