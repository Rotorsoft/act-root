import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadProject } from "../src/cli/load-project.js";

describe("loadProject", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "act-contracts-"));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "src", "feature"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(root, "src", "__tests__"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });

    await writeFile(join(root, "src", "order.ts"), "export const a = 1;");
    await writeFile(
      join(root, "src", "feature", "fulfillment.ts"),
      "export const b = 2;"
    );
    await writeFile(
      join(root, "src", "types.d.ts"),
      "declare const c: number;"
    );
    await writeFile(
      join(root, "src", "ui.tsx"),
      "export const D = () => null;"
    );
    await writeFile(join(root, "src", "x.test.ts"), "export const t = 1;");
    await writeFile(join(root, "src", "y.spec.ts"), "export const s = 1;");
    await writeFile(
      join(root, "src", "__tests__", "fixture.ts"),
      "export const f = 1;"
    );
    await writeFile(
      join(root, "node_modules", "pkg", "leak.ts"),
      "export const l = 1;"
    );
    await writeFile(join(root, ".git", "hidden.ts"), "export const h = 1;");
    await writeFile(join(root, "README.md"), "# docs");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("includes only .ts source files outside skip patterns", async () => {
    const { files, truncated } = await loadProject(root);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(["src/feature/fulfillment.ts", "src/order.ts"]);
    expect(truncated).toBe(false);
  });

  it("returns truncated=true when maxFiles is exceeded", async () => {
    const { files, truncated } = await loadProject(root, { maxFiles: 1 });
    expect(files).toHaveLength(1);
    expect(truncated).toBe(true);
  });

  it("returns an empty result for a non-existent root", async () => {
    const { files, truncated } = await loadProject(join(root, "missing"));
    expect(files).toEqual([]);
    expect(truncated).toBe(false);
  });

  it("returns an empty result when root is a file", async () => {
    const { files, truncated } = await loadProject(
      join(root, "src", "order.ts")
    );
    expect(files).toEqual([]);
    expect(truncated).toBe(false);
  });
});
