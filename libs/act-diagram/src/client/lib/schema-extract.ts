/**
 * Best-effort capture of Zod schema source text for each event declared
 * in `.emits({ ... })` blocks. The extractor walks the original source
 * (not the transpiled JS), tracks strings/comments/templates, and slices
 * out each value expression by balanced-bracket matching.
 *
 * Returned text is whatever the user wrote — `z.object({...})`,
 * `z.string()`, `OrderPlacedSchema`, even a multi-line expression. The
 * intent is fidelity to author intent rather than canonical form.
 */

type Entry = { key: string; value_start: number; value_end: number };

const is_w_s = (c: string | undefined) =>
  c === " " || c === "\t" || c === "\n" || c === "\r";
const is_ident = (c: string | undefined) => !!c && /[\w$]/.test(c);

/** Skip whitespace and comments starting at `from`. Returns new index. */
function skip_trivia(src: string, from: number): number {
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (is_w_s(c)) {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i - 1] === "*" && src[i] === "/")) i++;
      i++;
      continue;
    }
    break;
  }
  return i;
}

/**
 * Consume one value expression starting at `start`. Stops at a top-level
 * `,` or the closing `}` of the enclosing emits object. Returns the index
 * of that stop character.
 */
function read_value(src: string, start: number): number {
  let i = start;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    // String literals
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    // Template literal — track `${...}` nesting for brace balance
    if (c === "`") {
      i++;
      while (i < src.length && src[i] !== "`") {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          let td = 1;
          i += 2;
          while (i < src.length && td > 0) {
            if (src[i] === "{") td++;
            else if (src[i] === "}") td--;
            if (td > 0) i++;
          }
          i++;
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    // Comments
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i - 1] === "*" && src[i] === "/")) i++;
      i++;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") {
      depth++;
      i++;
      continue;
    }
    if (c === ")" || c === "]") {
      depth--;
      i++;
      continue;
    }
    if (c === "}") {
      if (depth === 0) return i;
      depth--;
      i++;
      continue;
    }
    if (c === "," && depth === 0) return i;
    i++;
  }
  return i;
}

/**
 * Parse the object literal whose opening `{` is at `start_brace`.
 * Returns the top-level entries and the index of the matching `}`,
 * or null if the literal was malformed.
 */
function parse_object_literal(
  src: string,
  start_brace: number
): { entries: Entry[]; end_brace: number } | null {
  const entries: Entry[] = [];
  let i = start_brace + 1;

  while (i < src.length) {
    i = skip_trivia(src, i);
    if (src[i] === "}") return { entries, end_brace: i };

    // Key — identifier or quoted string
    let key = "";
    let key_start = i;
    let key_end = i;
    let key_was_identifier = false;
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      key_start = ++i;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        i++;
      }
      key = src.slice(key_start, i);
      key_end = i;
      i++;
    } else if (is_ident(src[i])) {
      key_start = i;
      while (is_ident(src[i])) i++;
      key = src.slice(key_start, i);
      key_end = i;
      key_was_identifier = true;
    } else {
      // Unknown token — bail to keep extraction robust
      return null;
    }

    i = skip_trivia(src, i);
    if (src[i] !== ":") {
      // Shorthand (`{ Foo, Bar }`) — value is the identifier itself.
      // This is the common case for `.emits({ TicketOpened })` patterns
      // where the schema is imported under the same name as the event.
      if (key_was_identifier) {
        entries.push({ key, value_start: key_start, value_end: key_end });
      }
      while (i < src.length && src[i] !== "," && src[i] !== "}") i++;
      if (src[i] === ",") i++;
      continue;
    }
    i++; // ":"
    i = skip_trivia(src, i);

    const value_start = i;
    const value_end = read_value(src, i);
    entries.push({ key, value_start, value_end });
    i = value_end;
    if (src[i] === ",") i++;
  }
  return null;
}

/**
 * Consume one top-level expression starting at `start`. Stops at `;`
 * at depth 0, or end-of-file. Mirrors `read_value` but operates outside
 * an object literal — used to extract the right-hand side of
 * `const IDENT = <expr>;`.
 */
function read_top_level_expression(src: string, start: number): number {
  let i = start;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === "`") {
      i++;
      while (i < src.length && src[i] !== "`") {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          let td = 1;
          i += 2;
          while (i < src.length && td > 0) {
            if (src[i] === "{") td++;
            else if (src[i] === "}") td--;
            if (td > 0) i++;
          }
          i++;
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i - 1] === "*" && src[i] === "/")) i++;
      i++;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") {
      depth++;
      i++;
      continue;
    }
    if (c === ")" || c === "}" || c === "]") {
      depth--;
      i++;
      continue;
    }
    if (c === ";" && depth === 0) return i;
    i++;
  }
  return i;
}

/**
 * Build a map of every top-level identifier assignment in `src`.
 *
 *   const Foo = z.object({...});            → Foo  → "z.object({...})"
 *   export const Bar: T = some_expr;         → Bar  → "some_expr"
 *   let Baz = "literal";                    → Baz  → "\"literal\""
 *
 * Used so cross-file shorthand `.emits({ TicketOpened })` can resolve
 * to the actual Zod expression defined in another module.
 */
export function extract_identifier_assignments(
  src: string
): Map<string, string> {
  const out = new Map<string, string>();
  // The type-annotation arm is line-bounded (`[^=\n;]`) and explicitly
  // capped at 256 chars so the inner `+` can't drive O(N²) backtracking
  // across pathological inputs like many `#let $:` repetitions without
  // a closing `=`. Real TS type annotations on a top-level binding are
  // dramatically shorter than 256 chars — a binding with a longer one
  // simply isn't captured here, which is fine for the cross-file lookup.
  const re =
    /(?:^|[^\w$])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n;]{1,256})?=\s*/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const ident = m[1];
    if (out.has(ident)) {
      // Keep the first assignment; later reassignments are uncommon
      // and would just confuse the lookup.
      continue;
    }
    const start = m.index + m[0].length;
    const end = read_top_level_expression(src, start);
    const text = src.slice(start, end).trim();
    if (text) out.set(ident, text);
    re.lastIndex = end;
  }
  return out;
}

/**
 * Locate the object literal a top-level identifier points at. Handles:
 *
 *   const Events = { Foo: z.string(), Bar: z.number() };
 *   const Events: EventMap = { ... };
 *   let Events = { ... };
 *
 * Returns the index of the opening `{`, or -1 if the identifier can't
 * be resolved to an inline object literal.
 */
function find_identifier_object_literal(src: string, ident: string): number {
  // Match `const/let/var IDENT [: T] =` followed by optional whitespace.
  // The capture stops just before whatever the value is. See
  // `extract_identifier_assignments` for why the type-annotation arm
  // uses `[^=\n;]+` (greedy, no inner `\s*`) — same ReDoS hazard.
  const re = new RegExp(
    `(?:^|[^\\w$])(?:const|let|var)\\s+${ident}\\b\\s*(?::[^=\\n;]+)?=\\s*`,
    "m"
  );
  const m = re.exec(src);
  if (!m) return -1;
  const after = m.index + m[0].length;
  const skipped = skip_trivia(src, after);
  return src[skipped] === "{" ? skipped : -1;
}

/** Bare-identifier matcher; used to decide whether to chase a value. */
const BARE_IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * Find every `.emits( ... )` call in `src` and extract the Zod source
 * text for any event name in `event_names`. Resolves three indirection
 * patterns:
 *
 *   .emits({ Foo: z.object(...) })   → direct value capture
 *   .emits({ Foo })                  → shorthand → chase `Foo` to its
 *                                      definition, locally or via
 *                                      `external` (cross-file)
 *   .emits(EventsObj)                → chase the identifier to its
 *                                      `const EventsObj = { ... }`
 *
 * Returns a map keyed by event name; missing events stay absent.
 */
export function extract_schemas_from_source(
  src: string,
  event_names: Set<string>,
  external?: Map<string, string>
): Map<string, string> {
  const out = new Map<string, string>();
  if (!src || event_names.size === 0) return out;
  // Same-file identifier map, scanned once for the shorthand case.
  const local_idents = extract_identifier_assignments(src);
  const deref = (text: string): string =>
    BARE_IDENT_RE.test(text)
      ? (local_idents.get(text) ?? external?.get(text) ?? text)
      : text;
  const emits_re = /\.emits\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = emits_re.exec(src)) !== null) {
    let i = skip_trivia(src, emits_re.lastIndex);
    // `.emits(IDENT)` — chase the identifier to its object literal.
    if (is_ident(src[i])) {
      const start = i;
      while (is_ident(src[i])) i++;
      const ident = src.slice(start, i);
      const obj_start = find_identifier_object_literal(src, ident);
      if (obj_start < 0) continue;
      i = obj_start;
    }
    if (src[i] !== "{") continue;
    const parsed = parse_object_literal(src, i);
    if (!parsed) continue;
    for (const e of parsed.entries) {
      if (!event_names.has(e.key)) continue;
      const raw = src.slice(e.value_start, e.value_end).trim();
      const text = deref(raw);
      if (text) out.set(e.key, text);
    }
    emits_re.lastIndex = Math.max(emits_re.lastIndex, parsed.end_brace + 1);
  }
  return out;
}
