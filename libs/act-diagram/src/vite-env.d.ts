/// <reference types="vite/client" />

// File System Access API (Chrome/Edge) — dev mode only
declare function showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;

interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>;
}
