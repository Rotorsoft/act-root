import { describe, expect, it } from "vitest";
import { topoSort } from "../src/client/lib/sort.js";
import type { FileTab } from "../src/client/types/file-tab.js";

describe("topoSort", () => {
  it("sorts files by dependency order", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `import { TicketSlice } from "./slices.js";`,
      },
      {
        path: "src/slices.ts",
        content: `import { Ticket } from "./states.js";`,
      },
      { path: "src/states.ts", content: `import { z } from "zod";` },
    ];
    const sorted = topoSort(files);
    const paths = sorted.map((f) => f.path);
    expect(paths.indexOf("src/states.ts")).toBeLessThan(
      paths.indexOf("src/slices.ts")
    );
    expect(paths.indexOf("src/slices.ts")).toBeLessThan(
      paths.indexOf("src/app.ts")
    );
  });

  it("returns single file unchanged", () => {
    const files: FileTab[] = [{ path: "src/app.ts", content: "const x = 1;" }];
    expect(topoSort(files)).toEqual(files);
  });

  it("handles empty array", () => {
    expect(topoSort([])).toEqual([]);
  });

  it("handles circular dependencies gracefully", () => {
    const files: FileTab[] = [
      { path: "src/a.ts", content: `import { b } from "./b.js";` },
      { path: "src/b.ts", content: `import { a } from "./a.js";` },
    ];
    const sorted = topoSort(files);
    expect(sorted).toHaveLength(2);
  });

  it("resolves parent directory imports (..)", () => {
    const files: FileTab[] = [
      { path: "src/shared/types.ts", content: `export const T = 1;` },
      {
        path: "src/features/app.ts",
        content: `import { T } from "../shared/types.js";`,
      },
    ];
    const sorted = topoSort(files);
    const paths = sorted.map((f) => f.path);
    expect(paths.indexOf("src/shared/types.ts")).toBeLessThan(
      paths.indexOf("src/features/app.ts")
    );
  });

  it("handles file at root level (no directory)", () => {
    const files: FileTab[] = [
      { path: "types.ts", content: `export const T = 1;` },
      { path: "app.ts", content: `import { T } from "./types.js";` },
    ];
    const sorted = topoSort(files);
    const paths = sorted.map((f) => f.path);
    expect(paths.indexOf("types.ts")).toBeLessThan(paths.indexOf("app.ts"));
  });

  it("handles imports that don't resolve to any file", () => {
    const files: FileTab[] = [
      {
        path: "src/app.ts",
        content: `import { z } from "zod";\nimport { x } from "unknown";`,
      },
    ];
    expect(topoSort(files)).toHaveLength(1);
  });

  it("handles .ts extension in import path", () => {
    const files: FileTab[] = [
      { path: "src/types.ts", content: `export type X = string;` },
      { path: "src/app.ts", content: `import type { X } from "./types.ts";` },
    ];
    const sorted = topoSort(files);
    const paths = sorted.map((f) => f.path);
    expect(paths.indexOf("src/types.ts")).toBeLessThan(
      paths.indexOf("src/app.ts")
    );
  });

  it("handles scoped package imports (@org/pkg)", () => {
    const files: FileTab[] = [
      {
        path: "packages/utils/src/index.ts",
        content: `export const util = 1;`,
      },
      { path: "src/app.ts", content: `import { util } from "@myorg/utils";` },
    ];
    expect(topoSort(files)).toHaveLength(2);
  });

  it("handles scoped import with no package name", () => {
    const files: FileTab[] = [
      { path: "src/app.ts", content: `import { x } from "@org/";` },
      { path: "src/types.ts", content: `export const x = 1;` },
    ];
    const sorted = topoSort(files);
    expect(sorted).toHaveLength(2);
  });

  it("dep already seeded in inDegree map (line 36 branch)", () => {
    // File A depends on shared. File B also depends on shared.
    // When processing B's dep on shared, shared is already in inDegree map.
    // This exercises the `?? 0` fallback not being used since dep IS in inDegree.
    const files: FileTab[] = [
      { path: "src/shared.ts", content: `export const x = 1;` },
      {
        path: "src/a.ts",
        content: `import { x } from "./shared.js";\nimport { y } from "./shared.js";`,
      },
      {
        path: "src/b.ts",
        content: `import { x } from "./shared.js";`,
      },
    ];
    const sorted = topoSort(files);
    const paths = sorted.map((f) => f.path);
    // shared should come first
    expect(paths.indexOf("src/shared.ts")).toBe(0);
  });

  it("handles multiple files with shared dependency (in-degree > 1)", () => {
    const files: FileTab[] = [
      { path: "src/shared.ts", content: `export const x = 1;` },
      { path: "src/a.ts", content: `import { x } from "./shared.js";` },
      { path: "src/b.ts", content: `import { x } from "./shared.js";` },
    ];
    const sorted = topoSort(files);
    const paths = sorted.map((f) => f.path);
    expect(paths.indexOf("src/shared.ts")).toBeLessThan(
      paths.indexOf("src/a.ts")
    );
    expect(paths.indexOf("src/shared.ts")).toBeLessThan(
      paths.indexOf("src/b.ts")
    );
  });
});
