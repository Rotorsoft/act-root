/**
 * Navigate from a diagram element click to the exact definition in code.
 * Builds type-specific regex patterns, searches all .ts files, and
 * returns the file path, line, and column of the match.
 *
 * Pure function — no side effects, no VS Code / Monaco dependency.
 */
import type { FileTab } from "../types/index.js";

/** Check if a position in source text falls inside a comment */
function isInsideComment(content: string, matchIndex: number): boolean {
  const before = content.slice(0, matchIndex);
  const lastNl = before.lastIndexOf("\n");
  const lineStart = lastNl >= 0 ? lastNl + 1 : 0;
  const lineEnd = content.indexOf("\n", matchIndex);
  const lineText = content
    .slice(lineStart, lineEnd >= 0 ? lineEnd : content.length)
    .trimStart();

  // Line comment or JSDoc continuation
  if (
    lineText.startsWith("//") ||
    lineText.startsWith("*") ||
    lineText.startsWith("/*")
  ) {
    return true;
  }

  // Check if inside a block comment that started on a previous line
  const lastBlockOpen = before.lastIndexOf("/*");
  if (lastBlockOpen >= 0) {
    const lastBlockClose = before.lastIndexOf("*/");
    if (lastBlockClose < lastBlockOpen) return true; // unclosed block comment
  }

  return false;
}

/** Find the first non-comment match of a regex in content, return its index or -1 */
function findNonCommentMatch(
  content: string,
  re: RegExp,
  startFrom = 0
): number {
  /* v8 ignore next -- both branches produce equivalent "g" flag */
  const globalRe = new RegExp(
    re.source,
    re.flags.includes("g") ? re.flags : re.flags + "g"
  );
  globalRe.lastIndex = startFrom;
  let match: RegExpExecArray | null;
  while ((match = globalRe.exec(content)) !== null) {
    if (!isInsideComment(content, match.index)) return match.index;
  }
  return -1;
}

/** Compute line/col for a character index in content */
function positionAt(
  content: string,
  index: number
): { line: number; col: number } {
  const before = content.slice(0, index);
  const line = before.split("\n").length;
  const lastNl = before.lastIndexOf("\n");
  const col = index - (lastNl >= 0 ? lastNl : 0);
  return { line, col };
}

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

type NavigateResult = { file: string; line: number; col: number };

export function navigateToCode(
  files: FileTab[],
  name: string,
  type?: string,
  targetFile?: string
): NavigateResult | undefined {
  // Direct file navigation — find act() call in the file
  if (type === "file") {
    const file = files.find((f) => f.path === name || f.path.endsWith(name));
    if (file) {
      const actMatch = /\bact\s*\(\s*\)/.exec(file.content);
      if (actMatch) {
        const { line, col } = positionAt(file.content, actMatch.index);
        return { file: file.path, line, col };
      }
      return { file: file.path, line: 1, col: 1 };
    }
    return undefined;
  }

  // If targetFile provided, find the name within that file with type-aware priority
  if (targetFile) {
    const file = files.find((f) => f.path === targetFile);
    if (file) {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const nameRe = new RegExp(`\\b${esc}\\b`, "g");
      // For events: search inside .patch() block first, then .emits()
      // For actions: search inside .on() block
      const blockOrder =
        type === "event"
          ? [".patch(", ".emits("]
          : type === "action"
            ? [".on("]
            : [];

      for (const block of blockOrder) {
        const blockStart = file.content.indexOf(block);
        if (blockStart < 0) continue;
        const idx = findNonCommentMatch(file.content, nameRe, blockStart);
        if (idx >= 0) {
          const { line, col } = positionAt(file.content, idx);
          return { file: file.path, line, col };
        }
      }

      // Fallback: first non-comment occurrence of name in file
      const idx = findNonCommentMatch(file.content, nameRe);
      if (idx >= 0) {
        const { line, col } = positionAt(file.content, idx);
        return { file: file.path, line, col };
      }
    }
    return undefined;
  }

  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = buildPatterns(esc, type);

  for (const re of patterns) {
    for (let i = 0; i < files.length; i++) {
      if (!/\.tsx?$/.test(files[i].path)) continue;
      const content = files[i].content;
      /* v8 ignore next -- buildPatterns never includes "g" flag */
      const globalRe = new RegExp(
        re.source,
        re.flags.includes("g") ? re.flags : re.flags + "g"
      );
      let match: RegExpExecArray | null;
      while ((match = globalRe.exec(content)) !== null) {
        if (isInsideComment(content, match.index)) continue;

        const matchText = match[0];
        const nameOffsetInMatch = matchText.lastIndexOf(name);
        /* v8 ignore next -- name always appears in match text */
        const nameStart =
          nameOffsetInMatch >= 0
            ? match.index + nameOffsetInMatch
            : match.index;
        const { line, col } = positionAt(content, nameStart);
        return { file: files[i].path, line, col };
      }
    }
  }

  return undefined;
}
