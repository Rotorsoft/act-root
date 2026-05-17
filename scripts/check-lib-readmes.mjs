#!/usr/bin/env node
/**
 * Section-presence check for `libs/(any)/README.md` (ticket #751).
 *
 * Every lib README must follow the canonical structure: title + tagline,
 * "Why this package", Installation, Quick start, Related packages,
 * Documentation, License. Optional sections (API, Configuration, Common
 * patterns, "When to use this vs ...", Compatibility, Stability) are
 * encouraged but not enforced — their fit varies per lib.
 *
 * Deprecated packages can opt out by including either an HTML-comment
 * marker (with the body `canonical-check: deprecated`) or a GFM warning
 * banner mentioning "deprecat" in the first 30 lines.
 *
 * Exits non-zero on any violation. Wire into CI alongside lint/test.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const LIBS_DIR = new URL("../libs/", import.meta.url).pathname;

/** H2 headings every lib README must contain. */
const REQUIRED_SECTIONS = [
  "Why this package",
  "Installation",
  "Quick start",
  "Related packages",
  "Documentation",
  "License",
];

// Searched as a substring — no need to match the surrounding HTML
// comment delimiters, which would trip JS's HTML-comment compatibility
// rule if we embedded them literally in source.
const SKIP_MARKER = "canonical-check: deprecated";

function isDeprecated(body) {
  if (body.includes(SKIP_MARKER)) return true;
  const head = body.split("\n").slice(0, 30).join("\n").toLowerCase();
  return head.includes("> [!warning]") && head.includes("deprecat");
}

function checkReadme(_libName, path) {
  const body = readFileSync(path, "utf8");
  const errors = [];

  if (!/^# /m.test(body)) {
    errors.push("missing H1 title");
  }

  // Tagline: an italicized line within the first 10 lines, just under the H1.
  // Badges between H1 and the italic line are fine. Accept _..._ or *...*.
  const head10 = body.split("\n").slice(0, 10).join("\n");
  if (!/^(?:_[^_].*_|\*[^*].*\*)\s*$/m.test(head10)) {
    errors.push("missing italicized one-line tagline under the H1");
  }

  if (isDeprecated(body)) {
    // Deprecated packages are exempt from the canonical-section check.
    // Title + tagline are still required so the npm landing page renders.
    return errors;
  }

  for (const heading of REQUIRED_SECTIONS) {
    const re = new RegExp(`^## ${heading.replace(/ /g, "\\s+")}\\b`, "im");
    if (!re.test(body)) {
      errors.push(`missing required section: "## ${heading}"`);
    }
  }

  return errors;
}

let failed = 0;
for (const entry of readdirSync(LIBS_DIR).sort()) {
  const full = join(LIBS_DIR, entry);
  if (!statSync(full).isDirectory()) continue;
  const readmePath = join(full, "README.md");
  let errors;
  try {
    errors = checkReadme(entry, readmePath);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(`FAIL libs/${entry}: README.md missing`);
      failed++;
      continue;
    }
    throw err;
  }
  if (errors.length === 0) {
    console.log(`ok   libs/${entry}`);
  } else {
    failed++;
    console.error(`FAIL libs/${entry}:`);
    for (const e of errors) console.error(`     - ${e}`);
  }
}

if (failed > 0) {
  console.error(
    `\n${failed} lib README(s) violate the canonical section structure. See ticket #751 and the canonical template in libs/act-pino/README.md.`
  );
  process.exit(1);
}
console.log("\nAll lib READMEs match the canonical section structure.");
