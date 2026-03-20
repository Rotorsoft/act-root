import { gunzipSync } from "zlib";

/**
 * Extract .d.ts and package.json from a gzipped npm tarball buffer.
 * Pure Node.js — avoids macOS BSD tar stripping `@` from directory names.
 */
export function extractTypesFromTarball(tarGz: Buffer): Map<string, string> {
  const tar = gunzipSync(tarGz);
  const files = new Map<string, string>();
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    // End of archive — two consecutive zero blocks
    if (header[0] === 0) break;

    const fullName = header
      .subarray(0, 100)
      .toString("utf-8")
      .replace(/\0/g, "");

    const sizeOctal = header
      .subarray(124, 136)
      .toString("utf-8")
      .replace(/\0/g, "")
      .trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const typeFlag = header[156]; // 48='0' regular, 0=regular, 53='5' dir

    offset += 512;

    if ((typeFlag === 48 || typeFlag === 0) && size > 0) {
      // Strip leading "package/" from npm tarballs
      // Strip first path segment (varies: "package/", "node/", etc.)
      const path = fullName.replace(/^[^/]+\//, "");
      if (
        path.endsWith(".d.ts") ||
        path.endsWith(".d.ts.map") ||
        path === "package.json"
      ) {
        files.set(path, tar.subarray(offset, offset + size).toString("utf-8"));
      }
    }

    // Advance to next 512-byte boundary
    offset += Math.ceil(size / 512) * 512;
  }

  return files;
}
