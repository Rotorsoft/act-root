/**
 * Navigate from a diagram element click to the exact definition in code.
 * Builds type-specific regex patterns, searches all .ts files, and
 * returns the file path, line, and column of the match.
 *
 * Pure function — no side effects, no VS Code / Monaco dependency.
 */
import type { FileTab } from "../types/index.js";
import { stripNonCode } from "./evaluate.js";

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
    // Match event name inside .emits({ EventName: ... }) — inline declaration
    new RegExp(`\\.emits\\([\\s\\S]*?(${esc})\\s*:`),
    // Match event name as key in a schema object: EventName: z.object(...)
    new RegExp(`(${esc})\\s*:\\s*z\\.object\\(`),
  ];
  const reactionPatterns = [
    // .do(handlerName) or .do(module.handlerName) — handler declaration in builder
    new RegExp(`\\.do\\(\\s*(?:\\w+\\.)?(${esc})\\b`),
    // inline function in .do()
    new RegExp(
      `\\.on\\(\\s*["'\`][^"'\`]+["'\`]\\s*\\)\\s*\\.do\\(\\s*(?:async\\s+)?function\\s+(${esc})\\b`
    ),
    // Fallback: function definition
    new RegExp(`(?:export\\s+)?async\\s+function\\s+(${esc})\\s*\\(`),
  ];
  const projectionPatterns = [
    new RegExp(`(?:const|let|var)\\s+(${esc})\\s*=\\s*projection\\s*\\(`),
    new RegExp(`projection\\(\\s*["'\`](${esc})["'\`]`),
  ];
  const guardPatterns = [
    // Guard definition — prefer jumping to the declaration
    new RegExp(`(?:const|let|var)\\s+(${esc})\\s*(?::\\s*Invariant)?\\s*=`),
    new RegExp(`rule\\(\\s*["'\`](${esc})["'\`]`),
    new RegExp(`description:\\s*["'\`](${esc})["'\`]`),
    // .given() usage in the state builder — last resort
    new RegExp(`\\.given\\([\\s\\S]*?(${esc})`),
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
  // Strip non-code once per file — offsets stay valid
  const stripped = new Map<string, string>();
  const code = (f: FileTab) => {
    let c = stripped.get(f.path);
    if (c === undefined) {
      c = stripNonCode(f.content, "nav");
      stripped.set(f.path, c);
    }
    return c;
  };

  // Direct file navigation — find act() call in the file
  if (type === "file") {
    const file = files.find((f) => f.path === name || f.path.endsWith(name));
    if (file) {
      const actMatch = /\bact\s*\(\s*\)/.exec(code(file));
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
      const c = code(file);
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      // For events: navigate to .emits() in the state builder
      if (type === "event") {
        const emitsBlockRe = new RegExp(
          `\\.emits\\([\\s\\S]*?(${esc})\\s*[,:}]`
        );
        const blockMatch = emitsBlockRe.exec(c);
        if (blockMatch) {
          const nameIdx = blockMatch.index + blockMatch[0].lastIndexOf(name);
          const { line, col } = positionAt(file.content, nameIdx);
          return { file: file.path, line, col };
        }
        const nameRe = new RegExp(`\\b${esc}\\b`, "g");
        if (nameRe.exec(c)) {
          const emitsMatch = /\.emits\s*\(/.exec(c);
          if (emitsMatch) {
            const { line, col } = positionAt(
              file.content,
              emitsMatch.index + 1
            );
            return { file: file.path, line, col };
          }
        }
      }

      // For guards: find the description string, then jump to the containing const declaration
      if (type === "guard") {
        const descRe = new RegExp(`description:\\s*["'\`]${esc}["'\`]`);
        const descMatch = descRe.exec(c);
        if (descMatch) {
          const before = c.slice(0, descMatch.index);
          const declRe =
            /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*Invariant[^=]*)?\s*=/g;
          let lastDecl: RegExpExecArray | null = null;
          let m: RegExpExecArray | null;
          while ((m = declRe.exec(before)) !== null) {
            lastDecl = m;
          }
          if (lastDecl) {
            const nameIdx = lastDecl.index + lastDecl[0].indexOf(lastDecl[1]);
            const { line, col } = positionAt(file.content, nameIdx);
            return { file: file.path, line, col };
          }
          const { line, col } = positionAt(file.content, descMatch.index);
          return { file: file.path, line, col };
        }
      }

      // For actions: search inside .on() block
      if (type === "action") {
        const nameRe = new RegExp(`\\b${esc}\\b`, "g");
        const blockStart = c.indexOf(".on(");
        if (blockStart >= 0) {
          nameRe.lastIndex = blockStart;
          const match = nameRe.exec(c);
          if (match) {
            const { line, col } = positionAt(file.content, match.index);
            return { file: file.path, line, col };
          }
        }
      }

      // Fallback: first occurrence of name in code
      const nameRe = new RegExp(`\\b${esc}\\b`);
      const match = nameRe.exec(c);
      if (match) {
        const { line, col } = positionAt(file.content, match.index);
        return { file: file.path, line, col };
      }
    }
    return undefined;
  }

  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Search source files before test/spec files so definitions win over references
  const isTestFile = (p: string) =>
    /(?:\.spec\.|\.test\.|__tests__)/.test(p) || /\/test\//.test(p);
  const sortedFiles = [...files].sort(
    (a, b) => (isTestFile(a.path) ? 1 : 0) - (isTestFile(b.path) ? 1 : 0)
  );

  // Guards use description strings — find the description, then jump to the variable name
  if (type === "guard") {
    const descRe = new RegExp(`description:\\s*["'\`]${esc}["'\`]`);
    for (const f of sortedFiles) {
      if (!/\.tsx?$/.test(f.path)) continue;
      const c = code(f);
      const descMatch = descRe.exec(c);
      if (descMatch) {
        const before = c.slice(0, descMatch.index);
        const declRe =
          /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*Invariant[^=]*)?\s*=/g;
        let lastDecl: RegExpExecArray | null = null;
        let m: RegExpExecArray | null;
        while ((m = declRe.exec(before)) !== null) lastDecl = m;
        if (lastDecl) {
          const nameIdx = lastDecl.index + lastDecl[0].indexOf(lastDecl[1]);
          const { line, col } = positionAt(f.content, nameIdx);
          return { file: f.path, line, col };
        }
        const { line, col } = positionAt(f.content, descMatch.index);
        return { file: f.path, line, col };
      }
    }
  }

  const patterns = buildPatterns(esc, type);

  for (const re of patterns) {
    for (const f of sortedFiles) {
      if (!/\.tsx?$/.test(f.path)) continue;
      const c = code(f);
      const globalRe = new RegExp(re.source, re.flags + "g");
      let match: RegExpExecArray | null;
      while ((match = globalRe.exec(c)) !== null) {
        const matchText = match[0];
        const nameOffsetInMatch = matchText.lastIndexOf(name);
        const nameStart = match.index + Math.max(0, nameOffsetInMatch);
        const { line, col } = positionAt(f.content, nameStart);
        return { file: f.path, line, col };
      }
    }
  }

  return undefined;
}
