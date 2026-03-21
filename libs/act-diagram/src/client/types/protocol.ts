import type { FileTab } from "./file-tab.js";

/** Messages from the host environment to the diagram */
export type HostMessage =
  | { type: "files"; files: FileTab[] }
  | { type: "fileChanged"; path: string; content: string }
  | { type: "fileDeleted"; path: string };

/** Messages from the diagram to the host environment */
export type DiagramMessage =
  | { type: "navigate"; file: string; line: number; col: number }
  | { type: "aiRequest"; prompt: string; files: FileTab[] };
