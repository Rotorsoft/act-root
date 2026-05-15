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

type Entry = { key: string; valueStart: number; valueEnd: number };

const isWS = (c: string | undefined) =>
  c === " " || c === "\t" || c === "\n" || c === "\r";
const isIdent = (c: string | undefined) => !!c && /[\w$]/.test(c);

/** Skip whitespace and comments starting at `from`. Returns new index. */
function skipTrivia(src: string, from: number): number {
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (isWS(c)) {
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
function readValue(src: string, start: number): number {
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
 * Parse the object literal whose opening `{` is at `startBrace`.
 * Returns the top-level entries and the index of the matching `}`,
 * or null if the literal was malformed.
 */
function parseObjectLiteral(
  src: string,
  startBrace: number
): { entries: Entry[]; endBrace: number } | null {
  const entries: Entry[] = [];
  let i = startBrace + 1;

  while (i < src.length) {
    i = skipTrivia(src, i);
    if (src[i] === "}") return { entries, endBrace: i };

    // Key — identifier or quoted string
    let key = "";
    let keyStart = i;
    let keyEnd = i;
    let keyWasIdentifier = false;
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      keyStart = ++i;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        i++;
      }
      key = src.slice(keyStart, i);
      keyEnd = i;
      i++;
    } else if (isIdent(src[i])) {
      keyStart = i;
      while (isIdent(src[i])) i++;
      key = src.slice(keyStart, i);
      keyEnd = i;
      keyWasIdentifier = true;
    } else {
      // Unknown token — bail to keep extraction robust
      return null;
    }

    i = skipTrivia(src, i);
    if (src[i] !== ":") {
      // Shorthand (`{ Foo, Bar }`) — value is the identifier itself.
      // This is the common case for `.emits({ TicketOpened })` patterns
      // where the schema is imported under the same name as the event.
      if (keyWasIdentifier) {
        entries.push({ key, valueStart: keyStart, valueEnd: keyEnd });
      }
      while (i < src.length && src[i] !== "," && src[i] !== "}") i++;
      if (src[i] === ",") i++;
      continue;
    }
    i++; // ":"
    i = skipTrivia(src, i);

    const valueStart = i;
    const valueEnd = readValue(src, i);
    entries.push({ key, valueStart, valueEnd });
    i = valueEnd;
    if (src[i] === ",") i++;
  }
  return null;
}

/**
 * Consume one top-level expression starting at `start`. Stops at `;`
 * at depth 0, or end-of-file. Mirrors `readValue` but operates outside
 * an object literal — used to extract the right-hand side of
 * `const IDENT = <expr>;`.
 */
function readTopLevelExpression(src: string, start: number): number {
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
 *   export const Bar: T = someExpr;         → Bar  → "someExpr"
 *   let Baz = "literal";                    → Baz  → "\"literal\""
 *
 * Used so cross-file shorthand `.emits({ TicketOpened })` can resolve
 * to the actual Zod expression defined in another module.
 */
export function extractIdentifierAssignments(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re =
    /(?:^|[^\w$])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+?)?\s*=\s*/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const ident = m[1];
    if (out.has(ident)) {
      // Keep the first assignment; later reassignments are uncommon
      // and would just confuse the lookup.
      continue;
    }
    const start = m.index + m[0].length;
    const end = readTopLevelExpression(src, start);
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
function findIdentifierObjectLiteral(src: string, ident: string): number {
  // Match `const/let/var IDENT [: T] =` followed by optional whitespace.
  // The capture stops just before whatever the value is.
  const re = new RegExp(
    `(?:^|[^\\w$])(?:const|let|var)\\s+${ident}\\b\\s*(?::\\s*[^=]+?)?\\s*=\\s*`,
    "m"
  );
  const m = re.exec(src);
  if (!m) return -1;
  const after = m.index + m[0].length;
  const skipped = skipTrivia(src, after);
  return src[skipped] === "{" ? skipped : -1;
}

/** Bare-identifier matcher; used to decide whether to chase a value. */
const BARE_IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * Find every `.emits( ... )` call in `src` and extract the Zod source
 * text for any event name in `eventNames`. Resolves three indirection
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
export function extractSchemasFromSource(
  src: string,
  eventNames: Set<string>,
  external?: Map<string, string>
): Map<string, string> {
  const out = new Map<string, string>();
  if (!src || eventNames.size === 0) return out;
  // Same-file identifier map, scanned once for the shorthand case.
  const localIdents = extractIdentifierAssignments(src);
  const deref = (text: string): string =>
    BARE_IDENT_RE.test(text)
      ? (localIdents.get(text) ?? external?.get(text) ?? text)
      : text;
  const emitsRe = /\.emits\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = emitsRe.exec(src)) !== null) {
    let i = skipTrivia(src, emitsRe.lastIndex);
    // `.emits(IDENT)` — chase the identifier to its object literal.
    if (isIdent(src[i])) {
      const start = i;
      while (isIdent(src[i])) i++;
      const ident = src.slice(start, i);
      const objStart = findIdentifierObjectLiteral(src, ident);
      if (objStart < 0) continue;
      i = objStart;
    }
    if (src[i] !== "{") continue;
    const parsed = parseObjectLiteral(src, i);
    if (!parsed) continue;
    for (const e of parsed.entries) {
      if (!eventNames.has(e.key)) continue;
      const raw = src.slice(e.valueStart, e.valueEnd).trim();
      const text = deref(raw);
      if (text) out.set(e.key, text);
    }
    emitsRe.lastIndex = Math.max(emitsRe.lastIndex, parsed.endBrace + 1);
  }
  return out;
}
