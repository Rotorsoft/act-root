import { ValidationError } from "@rotorsoft/act";

/** Portable stream-filter body grammar: literal characters, `.` (any
 *  single character), and `.*` (any run). Everything else — escapes
 *  (`\.`), character classes (`[0-9]`), grouping/alternation (`(a|b)`),
 *  quantifiers (`+ ? { }`), and mid-pattern anchors — has no faithful
 *  `GLOB` translation and must throw instead of silently mis-matching.
 */
const PORTABLE_BODY = /^(?:\.\*|\.|[^\\^$.()[\]{}|+?*])*$/;

/** Translate a stream filter (regex-shaped or plain substring) into a
 *  SQLite `GLOB` pattern.
 *
 *  `GLOB` — not `LIKE` — because `GLOB` is **case-sensitive**,
 *  matching PG's `~` and InMemory's `RegExp`. SQLite's `LIKE` is ASCII
 *  case-insensitive, and its per-connection `PRAGMA case_sensitive_like`
 *  override is unreliable under libsql's pooled connections (a
 *  transaction and a follow-up read can land on different connections).
 *  `GLOB` carries its case-sensitivity in the operator itself, so it is
 *  correct regardless of which pooled connection runs the statement.
 *
 *  Honors `^` / `$` anchors and converts `.*` → `*`, `.` → `?`.
 *  Unanchored input gets `*` wildcards on both sides. `GLOB` has no
 *  ESCAPE clause and `%` / `_` are ordinary literals under it — so no
 *  escaping is needed. The portable grammar rejects `*`, `?`, and `[`
 *  as literals (they are metacharacters), so a literal can never collide
 *  with a `GLOB` wildcard.
 *
 *  Only the portable filter grammar documented on
 *  {@link QueryStreams.stream} is convertible: `^` / `$` anchors, `.`,
 *  `.*`, and literal characters. Any richer regex syntax throws
 *  {@link ValidationError} — a lossy approximation would silently
 *  return wrong rows, the worst available failure mode when the filter
 *  drives `reset` / `unblock`.
 *
 *  Examples:
 *  - `^abc$`  → `abc`        (exact)
 *  - `^abc.*` → `abc*`       (starts-with)
 *  - `.*abc$` → `*abc`       (ends-with)
 *  - `abc`    → `*abc*`      (contains)
 *  - `a.c`    → `*a?c*`      (single-char wildcard, contains)
 *  - `^a_c$`  → `a_c`        (literal underscore — ordinary under GLOB)
 *  - `(a|b)`  → throws {@link ValidationError}
 *
 */
export function stream_glob(input: string): string {
  let s = input;
  const start = s.startsWith("^");
  const end = s.endsWith("$");
  if (start) s = s.slice(1);
  if (end) s = s.slice(0, -1);
  if (!PORTABLE_BODY.test(s))
    throw new ValidationError(
      `stream filter pattern "${input}" — the SQLite adapter supports only the portable subset: "^" and "$" anchors, "." (any single character), ".*" (any run), and literal characters. Escapes, character classes, grouping, alternation, and quantifiers cannot be converted to GLOB; use stream_exact/source_exact for literal names`,
      input,
      "non-portable stream filter pattern"
    );
  const tokens: string[] = [];
  if (!start) tokens.push("*");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ".") {
      if (s[i + 1] === "*") {
        tokens.push("*");
        i++;
      } else tokens.push("?");
    } else tokens.push(c);
  }
  if (!end) tokens.push("*");
  // Collapse adjacent `*` wildcards — e.g. `^a.*` would otherwise yield
  // `a**`. GLOB treats `**` as `*`, but collapsing keeps the output
  // minimal and matches the old LIKE behavior.
  let out = "";
  let prev = "";
  for (const t of tokens) {
    if (t === "*" && prev === "*") continue;
    out += t;
    prev = t;
  }
  return out;
}
