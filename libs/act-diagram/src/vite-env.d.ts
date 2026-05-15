/// <reference types="vite/client" />

// File System Access API (Chrome/Edge) — dev mode only
declare function showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;

interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>;
}

/**
 * Build-time stamp of the package version. Defined by both tsup
 * (production bundle) and Vite (dev server) — see the matching
 * `define` blocks in `tsup.config.ts` / `vite.config.ts`. In dev the
 * value is suffixed with `-dev` so it's obvious you're not on the
 * published bundle.
 */
declare const __ACT_DIAGRAM_VERSION__: string;
