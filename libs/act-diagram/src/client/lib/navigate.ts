/**
 * Navigate from a diagram element click to the exact definition in code.
 * Builds type-specific regex patterns, searches all .ts files, and
 * returns the file path, line, and column of the match.
 *
 * Pure function — no side effects, no VS Code / Monaco dependency.
 */
import type { FileTab } from "../types/index.js";
import { strip_non_code } from "./evaluate.js";

/** Compute line/col for a character index in content */
function position_at(
  content: string,
  index: number
): { line: number; col: number } {
  const before = content.slice(0, index);
  const line = before.split("\n").length;
  const last_nl = before.lastIndexOf("\n");
  const col = index - (last_nl >= 0 ? last_nl : 0);
  return { line, col };
}

function build_patterns(esc: string, type?: string): RegExp[] {
  const state_patterns = [new RegExp(`state\\(\\s*\\{\\s*(${esc})\\s*[}:,]`)];
  const action_patterns = [new RegExp(`\\.on\\(\\s*\\{\\s*(${esc})\\s*[},:]`)];
  const event_patterns = [
    // Match event name inside .emits({ EventName: ... }) — inline declaration
    new RegExp(`\\.emits\\([\\s\\S]*?(${esc})\\s*:`),
    // Match event name as key in a schema object: EventName: z.object(...)
    new RegExp(`(${esc})\\s*:\\s*z\\.object\\(`),
  ];
  const reaction_patterns = [
    // .do(handler_name) or .do(module.handler_name) — handler declaration in builder
    new RegExp(`\\.do\\(\\s*(?:\\w+\\.)?(${esc})\\b`),
    // inline function in .do()
    new RegExp(
      `\\.on\\(\\s*["'\`][^"'\`]+["'\`]\\s*\\)\\s*\\.do\\(\\s*(?:async\\s+)?function\\s+(${esc})\\b`
    ),
    // Fallback: function definition
    new RegExp(`(?:export\\s+)?async\\s+function\\s+(${esc})\\s*\\(`),
  ];
  const projection_patterns = [
    new RegExp(`(?:const|let|var)\\s+(${esc})\\s*=\\s*projection\\s*\\(`),
    new RegExp(`projection\\(\\s*["'\`](${esc})["'\`]`),
  ];
  const guard_patterns = [
    // Guard definition — prefer jumping to the declaration
    new RegExp(`(?:const|let|var)\\s+(${esc})\\s*(?::\\s*Invariant)?\\s*=`),
    new RegExp(`rule\\(\\s*["'\`](${esc})["'\`]`),
    new RegExp(`description:\\s*["'\`](${esc})["'\`]`),
    // .given() usage in the state builder — last resort
    new RegExp(`\\.given\\([\\s\\S]*?(${esc})`),
  ];
  const slice_patterns = [
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
      return [...state_patterns, ...generic];
    case "action":
      return [...action_patterns, ...generic];
    case "event":
      return [...event_patterns, ...generic];
    case "reaction":
      return [...reaction_patterns, ...generic];
    case "projection":
      return [...projection_patterns, ...generic];
    case "guard":
      return [...guard_patterns, ...generic];
    default:
      return [
        ...slice_patterns,
        ...state_patterns,
        ...action_patterns,
        ...event_patterns,
        ...reaction_patterns,
        ...projection_patterns,
        ...guard_patterns,
        ...generic,
      ];
  }
}

type NavigateResult = { file: string; line: number; col: number };

export function navigate_to_code(
  files: FileTab[],
  name: string,
  type?: string,
  target_file?: string
): NavigateResult | undefined {
  // Strip non-code once per file — offsets stay valid
  const stripped = new Map<string, string>();
  const code = (f: FileTab) => {
    let c = stripped.get(f.path);
    if (c === undefined) {
      c = strip_non_code(f.content, "nav");
      stripped.set(f.path, c);
    }
    return c;
  };

  // Direct file navigation — find act() call in the file
  if (type === "file") {
    const file = files.find((f) => f.path === name || f.path.endsWith(name));
    if (file) {
      const act_match = /\bact\s*\(\s*\)/.exec(code(file));
      if (act_match) {
        const { line, col } = position_at(file.content, act_match.index);
        return { file: file.path, line, col };
      }
      return { file: file.path, line: 1, col: 1 };
    }
    return undefined;
  }

  // If target_file provided, find the name within that file with type-aware priority
  if (target_file) {
    const file = files.find((f) => f.path === target_file);
    if (file) {
      const c = code(file);
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      // For events: navigate to .emits() in the state builder
      if (type === "event") {
        const emits_block_re = new RegExp(
          `\\.emits\\([\\s\\S]*?(${esc})\\s*[,:}]`
        );
        const block_match = emits_block_re.exec(c);
        if (block_match) {
          const name_idx = block_match.index + block_match[0].lastIndexOf(name);
          const { line, col } = position_at(file.content, name_idx);
          return { file: file.path, line, col };
        }
        const name_re = new RegExp(`\\b${esc}\\b`, "g");
        if (name_re.exec(c)) {
          const emits_match = /\.emits\s*\(/.exec(c);
          if (emits_match) {
            const { line, col } = position_at(
              file.content,
              emits_match.index + 1
            );
            return { file: file.path, line, col };
          }
        }
      }

      // For guards: find the description string, then jump to the containing const declaration
      if (type === "guard") {
        const desc_re = new RegExp(`description:\\s*["'\`]${esc}["'\`]`);
        const desc_match = desc_re.exec(c);
        if (desc_match) {
          const before = c.slice(0, desc_match.index);
          const decl_re =
            /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*Invariant[^=]*)?\s*=/g;
          let last_decl: RegExpExecArray | null = null;
          let m: RegExpExecArray | null;
          while ((m = decl_re.exec(before)) !== null) {
            last_decl = m;
          }
          if (last_decl) {
            const name_idx =
              last_decl.index + last_decl[0].indexOf(last_decl[1]);
            const { line, col } = position_at(file.content, name_idx);
            return { file: file.path, line, col };
          }
          const { line, col } = position_at(file.content, desc_match.index);
          return { file: file.path, line, col };
        }
      }

      // For actions: search inside .on() block
      if (type === "action") {
        const name_re = new RegExp(`\\b${esc}\\b`, "g");
        const block_start = c.indexOf(".on(");
        if (block_start >= 0) {
          name_re.lastIndex = block_start;
          const match = name_re.exec(c);
          if (match) {
            const { line, col } = position_at(file.content, match.index);
            return { file: file.path, line, col };
          }
        }
      }

      // Fallback: first occurrence of name in code
      const name_re = new RegExp(`\\b${esc}\\b`);
      const match = name_re.exec(c);
      if (match) {
        const { line, col } = position_at(file.content, match.index);
        return { file: file.path, line, col };
      }
    }
    return undefined;
  }

  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Search source files before test/spec files so definitions win over references
  const is_test_file = (p: string) =>
    /(?:\.spec\.|\.test\.|__tests__)/.test(p) || /\/test\//.test(p);
  const sorted_files = [...files].sort(
    (a, b) => (is_test_file(a.path) ? 1 : 0) - (is_test_file(b.path) ? 1 : 0)
  );

  // Guards use description strings — find the description, then jump to the variable name
  if (type === "guard") {
    const desc_re = new RegExp(`description:\\s*["'\`]${esc}["'\`]`);
    for (const f of sorted_files) {
      if (!/\.tsx?$/.test(f.path)) continue;
      const c = code(f);
      const desc_match = desc_re.exec(c);
      if (desc_match) {
        const before = c.slice(0, desc_match.index);
        const decl_re =
          /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*Invariant[^=]*)?\s*=/g;
        let last_decl: RegExpExecArray | null = null;
        let m: RegExpExecArray | null;
        while ((m = decl_re.exec(before)) !== null) last_decl = m;
        if (last_decl) {
          const name_idx = last_decl.index + last_decl[0].indexOf(last_decl[1]);
          const { line, col } = position_at(f.content, name_idx);
          return { file: f.path, line, col };
        }
        const { line, col } = position_at(f.content, desc_match.index);
        return { file: f.path, line, col };
      }
    }
  }

  const patterns = build_patterns(esc, type);

  for (const re of patterns) {
    for (const f of sorted_files) {
      if (!/\.tsx?$/.test(f.path)) continue;
      const c = code(f);
      const global_re = new RegExp(re.source, re.flags + "g");
      let match: RegExpExecArray | null;
      while ((match = global_re.exec(c)) !== null) {
        const match_text = match[0];
        const name_offset_in_match = match_text.lastIndexOf(name);
        const name_start = match.index + Math.max(0, name_offset_in_match);
        const { line, col } = position_at(f.content, name_start);
        return { file: f.path, line, col };
      }
    }
  }

  return undefined;
}
