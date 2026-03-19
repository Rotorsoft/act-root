import { strToU8, zipSync } from "fflate";
import { projectFiles } from "../data/sample-app.js";
import type { FileTab } from "../types/index.js";

/** Download all project files as a zip archive */
export function downloadProject(files: FileTab[], name?: string) {
  const pkgName = (name || "act-app")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const paths = new Set(files.map((f) => f.path));
  const extras = projectFiles(name).filter((f) => !paths.has(f.path));
  const allFiles = [...files, ...extras];

  // Build zip file tree
  const zipData: Record<string, Uint8Array> = {};
  for (const f of allFiles) {
    zipData[`${pkgName}/${f.path}`] = strToU8(f.content);
  }

  const zipped = zipSync(zipData);
  const blob = new Blob([zipped.buffer as ArrayBuffer], {
    type: "application/zip",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${pkgName}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}
