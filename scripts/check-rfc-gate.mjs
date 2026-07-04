#!/usr/bin/env node
/**
 * RFC gate (ticket #1061, finishes #1035).
 *
 * The stability charter ([STABILITY.md]) protects the public surface, and the
 * `runStabilityTck` snapshot in `libs/act-tck/test/__snapshots__/` catches
 * *changes* to that surface in a PR diff. Neither *gates additions*: a PR can
 * grow the public surface (new export, builder method, port method, lifecycle
 * event) and CI stays green. `rfcs/` is the lightweight gate in front of that
 * one-way door — but until now nothing enforced it.
 *
 * This script enforces it mechanically. The stability snapshot is the
 * source-text proxy for the public surface (that's its whole job), so:
 *
 *   1. If the snapshot file didn't change between base and HEAD → the public
 *      surface didn't change → PASS.
 *   2. If it changed but did not *grow* (net non-blank added lines ≤ removed)
 *      → the change is a rename / removal / refactor, which the charter and
 *      the snapshot diff itself already cover → PASS. We deliberately only
 *      gate *additions* here.
 *   3. If it grew → the surface likely gained something. PASS only if the PR
 *      adds an `rfcs/NNNN-*.md` file, or a commit message / PR body links one.
 *      Otherwise FAIL with a pointer at `rfcs/0000-template.md`.
 *
 * Conservative by design: the remedy for a false positive is cheap (write the
 * one-page RFC, the README's standing advice is "when in doubt, open the RFC"),
 * and every file in the snapshot is charter-covered surface anyway.
 *
 * Dependency-free; uses only `git` and `node:`. Intended to run in CI on
 * pull_request with full history (`fetch-depth: 0`), but also runs locally:
 *
 *   BASE_REF=origin/master node scripts/check-rfc-gate.mjs
 *
 * Env:
 *   BASE_REF  base ref to diff against (default: origin/master)
 *   HEAD_REF  head ref (default: HEAD)
 *   PR_BODY   optional PR description; scanned for an RFC link
 */
import { execFileSync } from "node:child_process";

const SNAPSHOT_PATH =
  "libs/act-tck/test/__snapshots__/all-packages-stability.spec.ts.snap";
const RFC_FILE_RE = /^rfcs\/\d{4}-[^/]+\.md$/;
// Matches "rfcs/0007", "rfcs/0007-foo.md", "RFC 7", "RFC-0007" in prose.
const RFC_LINK_RE = /\brfcs\/\d{3,4}\b|\bRFC[-\s]?\d{1,4}\b/i;
// Explicit false-positive escape hatch: the snapshot embeds the source text of
// internal modules, so implementation-only growth (a longer log line, a new
// comment) trips the line counter without adding public surface. The PR body
// may declare the exemption with a reason — auditable in the PR itself:
//   rfc-gate: exempt — internal-only diff, no public surface added
const EXEMPT_RE = /^\s*rfc-gate:\s*exempt\s*[—-]+\s*\S.*$/im;

const BASE_REF = process.env.BASE_REF || "origin/master";
const HEAD_REF = process.env.HEAD_REF || "HEAD";
const PR_BODY = process.env.PR_BODY || "";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

/**
 * Resolve the diff base. Prefer the merge-base so we compare against where the
 * branch forked, not the tip of master (which would surface unrelated drift).
 * Falls back to the raw ref if merge-base can't be computed (shallow clone,
 * unrelated histories).
 */
function resolveBase() {
  try {
    return git(["merge-base", BASE_REF, HEAD_REF]).trim();
  } catch {
    return BASE_REF;
  }
}

/** `name-status` entries between base and HEAD: [{ status, path }]. */
function changedFiles(base) {
  const out = git(["diff", "--name-status", `${base}...${HEAD_REF}`]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      // For renames (R100) git emits old\tnew; take the destination path.
      return { status: status[0], path: rest[rest.length - 1] };
    });
}

/**
 * Did the snapshot grow? Walks the unified diff for the snapshot file and
 * counts non-blank added vs. removed content lines. Net-positive = growth.
 * Blank lines are ignored so reformatting noise doesn't trip the gate.
 */
function snapshotGrew(base) {
  const diff = git(["diff", "--unified=0", `${base}...${HEAD_REF}`, "--", SNAPSHOT_PATH]);
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") && line.slice(1).trim() !== "") added++;
    else if (line.startsWith("-") && line.slice(1).trim() !== "") removed++;
  }
  return { grew: added > removed, added, removed };
}

/** True if a new `rfcs/NNNN-*.md` file is added, or one is linked in commits/PR body. */
function hasRfc(base, files) {
  const addedRfc = files.find(
    (f) => (f.status === "A" || f.status === "R") && RFC_FILE_RE.test(f.path)
  );
  if (addedRfc) return { ok: true, reason: `RFC file added: ${addedRfc.path}` };

  if (RFC_LINK_RE.test(PR_BODY))
    return { ok: true, reason: "RFC linked in PR body" };

  const log = git(["log", "--format=%B", `${base}..${HEAD_REF}`]);
  if (RFC_LINK_RE.test(log))
    return { ok: true, reason: "RFC linked in a commit message" };

  return { ok: false };
}

function fail(addedRemoved) {
  console.error(
    [
      "",
      "RFC gate FAILED.",
      "",
      `The public-surface stability snapshot grew (${addedRemoved.added} added /`,
      `${addedRemoved.removed} removed non-blank lines in`,
      `  ${SNAPSHOT_PATH}),`,
      "which means this PR likely adds new public surface — a new export, builder",
      "method, port method, or lifecycle event. The stability charter protects that",
      "surface the moment it merges, so additions need a one-page RFC first.",
      "",
      "To fix, do one of:",
      "  1. Add the RFC: copy rfcs/0000-template.md to rfcs/NNNN-<slug>.md",
      "     (use the PR or issue number for NNNN) and fill it in.",
      "  2. If an RFC already exists, link it in the PR body or a commit message",
      "     (e.g. 'rfcs/0007' or 'RFC 7').",
      "  3. If the growth adds no public surface (internal implementation text",
      "     embedded in the snapshot), declare it in the PR body with a reason:",
      "     'rfc-gate: exempt — <why no public surface is added>'.",
      "  4. If this is a false positive (a rename/refactor the diff happened to grow,",
      "     or surface the charter already exempts — new optional field, new event",
      "     version), add the RFC anyway: 'when in doubt, open the RFC' (rfcs/README.md).",
      "",
      "See rfcs/README.md for what does and doesn't require one.",
      "",
    ].join("\n")
  );
  process.exit(1);
}

function main() {
  const base = resolveBase();
  const files = changedFiles(base);

  const snapshotChanged = files.some((f) => f.path === SNAPSHOT_PATH);
  if (!snapshotChanged) {
    console.log("RFC gate: public-surface snapshot unchanged — no RFC required.");
    return;
  }

  const growth = snapshotGrew(base);
  if (!growth.grew) {
    console.log(
      `RFC gate: snapshot changed but did not grow (${growth.added} added / ${growth.removed} removed non-blank lines) — rename/removal/refactor, no RFC required.`
    );
    return;
  }

  const exempt = PR_BODY.match(EXEMPT_RE);
  if (exempt) {
    console.log(
      `RFC gate: snapshot grew but the PR body declares an exemption — ${exempt[0].trim()}`
    );
    return;
  }

  const rfc = hasRfc(base, files);
  if (rfc.ok) {
    console.log(`RFC gate: surface grew and an RFC is present (${rfc.reason}) — OK.`);
    return;
  }

  fail(growth);
}

main();
