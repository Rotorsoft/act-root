import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * Runs the one-shot example the way the README says to, and checks the
 * scrape ends with the lines the README promises: the poison stream blocks.
 */
describe("prometheus recipe", () => {
  it("prints the scrape the README promises, poison stream blocked", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const { stdout } = await promisify(execFile)(
      "npx",
      ["tsx", join(here, "instrumented-app.ts")],
      { timeout: 30_000 }
    );
    expect(stdout).toContain(
      'act_events_committed_total{name="OrderPlaced"} 3'
    );
    expect(stdout).toContain('act_reactions_acked_total{lane="default"} 2');
    expect(stdout).toContain('act_reactions_blocked_total{lane="default"} 1');
    expect(stdout).toContain("act_streams_blocked 1");
  }, 40_000);
});
