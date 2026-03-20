/**
 * Navigate from a diagram element click to the exact definition in code.
 * Builds type-specific regex patterns, searches all .ts files, and
 * opens the file at the matching line with the word highlighted.
 */
import type { FileTab } from "../types/index.js";
import { openFileInEditor, revealWord } from "./vscode-init.js";

function buildPatterns(esc: string, type?: string): RegExp[] {
  const statePatterns = [new RegExp(`state\\(\\s*\\{\\s*(${esc})\\s*[}:,]`)];
  const actionPatterns = [new RegExp(`\\.on\\(\\s*\\{\\s*(${esc})\\s*[},:]`)];
  const eventPatterns = [
    new RegExp(`\\.emits\\(\\s*\\{[^}]*(${esc})\\s*:`),
    new RegExp(`\\.patch\\(\\s*\\{[^}]*(${esc})\\s*:`),
  ];
  const reactionPatterns = [
    new RegExp(`async\\s+function\\s+(${esc})\\s*\\(`),
    new RegExp(
      `\\.on\\(\\s*["'\`][^"'\`]+["'\`]\\s*\\)\\s*\\.do\\(\\s*(?:async\\s+)?function\\s+(${esc})\\b`
    ),
  ];
  const projectionPatterns = [
    new RegExp(`(?:const|let|var)\\s+(${esc})\\s*=\\s*projection\\s*\\(`),
    new RegExp(`projection\\(\\s*["'\`](${esc})["'\`]`),
  ];
  const guardPatterns = [
    new RegExp(`description:\\s*["'\`](${esc})["'\`]`),
    new RegExp(`(?:const|let|var)\\s+(${esc})\\s*(?::\\s*Invariant)?\\s*=`),
    new RegExp(`\\.given\\(\\s*\\[[^\\]]*["'\`](${esc})["'\`]`),
  ];
  const slicePatterns = [
    new RegExp(`(?:const|let|var)\\s+(${esc})\\s*=\\s*slice\\s*\\(`),
  ];
  const generic = [
    new RegExp(
      `(?:const|let|var)\\s+(${esc})\\s*=\\s*(?:state|slice|projection|act)\\s*\\(`
    ),
    new RegExp(`(?:const|let|var)\\s+(${esc})\\s*=`),
    new RegExp(`\\b(${esc})\\b`),
  ];

  switch (type) {
    case "state":
      return [...statePatterns, ...generic];
    case "action":
      return [...actionPatterns, ...generic];
    case "event":
      return [...eventPatterns, ...generic];
    case "reaction":
      return [...reactionPatterns, ...generic];
    case "projection":
      return [...projectionPatterns, ...generic];
    case "guard":
      return [...guardPatterns, ...generic];
    default:
      return [
        ...slicePatterns,
        ...statePatterns,
        ...actionPatterns,
        ...eventPatterns,
        ...reactionPatterns,
        ...projectionPatterns,
        ...guardPatterns,
        ...generic,
      ];
  }
}

export function navigateToCode(files: FileTab[], name: string, type?: string) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = buildPatterns(esc, type);

  for (const re of patterns) {
    for (let i = 0; i < files.length; i++) {
      if (!/\.tsx?$/.test(files[i].path)) continue;
      const match = re.exec(files[i].content);
      if (match) {
        const matchText = match[0];
        const nameOffsetInMatch = matchText.lastIndexOf(name);
        const nameStart =
          nameOffsetInMatch >= 0
            ? match.index + nameOffsetInMatch
            : match.index;
        const before = files[i].content.slice(0, nameStart);
        const lastNl = before.lastIndexOf("\n");
        const line = before.split("\n").length;
        const col = nameStart - (lastNl >= 0 ? lastNl : 0);
        void openFileInEditor(files[i].path).then(() => {
          setTimeout(() => revealWord(line, col, name.length), 100);
        });
        return;
      }
    }
  }
}
