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
  // Direct file navigation — open by path and highlight act()
  if (type === "file") {
    const file = files.find((f) => f.path === name || f.path.endsWith(name));
    if (file) {
      const actMatch = /\bact\s*\(\s*\)/.exec(file.content);
      void openFileInEditor(file.path).then(() => {
        if (actMatch) {
          const before = file.content.slice(0, actMatch.index);
          const line = before.split("\n").length;
          const lastNl = before.lastIndexOf("\n");
          const col = actMatch.index - (lastNl >= 0 ? lastNl : 0);
          setTimeout(() => revealWord(line, col), 100);
        }
      });
    }
    return;
  }

  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = buildPatterns(esc, type);

  for (const re of patterns) {
    for (let i = 0; i < files.length; i++) {
      if (!/\.tsx?$/.test(files[i].path)) continue;
      // Search all matches, skipping those inside comments
      const content = files[i].content;
      const globalRe = new RegExp(
        re.source,
        re.flags.includes("g") ? re.flags : re.flags + "g"
      );
      let match: RegExpExecArray | null;
      while ((match = globalRe.exec(content)) !== null) {
        // Check if match is inside a line comment or block comment
        const before = content.slice(0, match.index);
        const lastNl = before.lastIndexOf("\n");
        const lineText = content.slice(
          lastNl >= 0 ? lastNl + 1 : 0,
          content.indexOf("\n", match.index) >= 0
            ? content.indexOf("\n", match.index)
            : content.length
        );
        const trimmed = lineText.trimStart();
        if (
          trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*")
        ) {
          continue; // skip comment lines
        }

        const matchText = match[0];
        const nameOffsetInMatch = matchText.lastIndexOf(name);
        const nameStart =
          nameOffsetInMatch >= 0
            ? match.index + nameOffsetInMatch
            : match.index;
        const beforeName = content.slice(0, nameStart);
        const lastNlName = beforeName.lastIndexOf("\n");
        const line = beforeName.split("\n").length;
        const col = nameStart - (lastNlName >= 0 ? lastNlName : 0);
        void openFileInEditor(files[i].path).then(() => {
          setTimeout(() => revealWord(line, col), 100);
        });
        return;
      }
    }
  }
}
