import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Architecture harness — layering rules that must fail a build rather than
 * rely on anyone remembering them.
 *
 * Every rule here exists because it was broken. #1541 put an
 * `AsyncLocalStorage` in `internal/`, then a follow-up "fixed" it by moving
 * the declaration one directory over while `internal/` kept importing and
 * reading it — a relocation is not a decoupling, and nothing executable
 * noticed either time.
 *
 * The layering these rules encode:
 *
 * - `internal/` holds stateless implementations. They RECEIVE what they need
 *   (see `ReactionDeps.reaction_scope`, `DrainDeps.run_scoped`); they never
 *   reach for ambient state.
 * - PII is one module's business. `sensitive.ts` owns the marker,
 *   `internal/pii.ts` the transforms, and `builders/event-builder.ts` is the
 *   only place that composes them. Nothing else imports a `pii_*` helper.
 * - `scoped.ts` owns every `AsyncLocalStorage` and every operation on one.
 * - Ambient mechanisms are not public API.
 */

const SRC = new URL("../src/", import.meta.url).pathname;
const INTERNAL = join(SRC, "internal");

const ts_files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? ts_files(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : []
  );

const internal_sources = ts_files(INTERNAL).map((path) => ({
  name: path.slice(INTERNAL.length + 1),
  text: readFileSync(path, "utf8"),
}));

/** Strip block and line comments so prose about a rule never trips it. */
const code_of = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("architecture: internal/ is stateless", () => {
  it("has files to check", () => {
    // Guards the guard: a broken glob would make every rule below vacuous.
    expect(internal_sources.length).toBeGreaterThan(20);
  });

  it("imports no async context", () => {
    const offenders = internal_sources
      .filter(({ text }) => /from "node:async_hooks"/.test(code_of(text)))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("never imports a VALUE from scoped.ts — only types", () => {
    // A type import is erased at runtime and creates no dependency on ambient
    // state; a value import is exactly the coupling #1541 introduced.
    const offenders = internal_sources
      .filter(({ text }) =>
        /^import\s+(?!type\b)[^;]*from\s+"\.\.\/scoped\.js"/m.test(
          code_of(text)
        )
      )
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("declares no module-level mutable state", () => {
    // `const x = new Map()` / `= []` at column 0. Frozen literals with
    // contents (audit.ts's category list) are constants, not state.
    const offenders = internal_sources
      .filter(({ text }) =>
        /^(?:export )?const \w+(?:: [^=]+)? = (?:new [A-Z]|\[\]|\{\})/m.test(
          code_of(text)
        )
      )
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });
});

describe("architecture: public types live in types/", () => {
  // Three layers, by audience: types/ declares every public type,
  // the public runtime modules implement them, and internal/ is private.
  const outside = ts_files(SRC)
    .filter((p) => !p.startsWith(INTERNAL))
    .map((path) => ({
      name: path.slice(SRC.length),
      text: code_of(readFileSync(path, "utf8")),
    }));

  /** Every module a public entry point reaches through its re-exports. */
  const reached = (() => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = code_of(readFileSync(join(SRC, file), "utf8"));
      for (const m of text.matchAll(
        /^export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+"(\.[^"]+)\.js"/gm
      ))
        walk(join(file, "..", `${m[1]}.ts`));
    };
    for (const entry of ["index.ts", "types/index.ts", "test/index.ts"])
      walk(entry);
    return [...seen];
  })();

  it("never re-exports internal/", () => {
    const offenders = outside
      .filter(({ text }) => /^export [^;]*from "[./]*internal\//m.test(text))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("never imports internal/ from types/", () => {
    const offenders = outside
      .filter(({ name }) => name.startsWith("types/"))
      .filter(({ text }) => /from "\.\.\/internal\//.test(text))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("declares no public type outside types/", () => {
    const offenders = reached
      .filter((file) => !file.startsWith("types/"))
      .filter((file) =>
        /^export (?:type|interface) \w/m.test(
          code_of(readFileSync(join(SRC, file), "utf8"))
        )
      );
    expect(reached.length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});

describe("architecture: ambient context is owned by scoped.ts", () => {
  const outside_scoped = [
    ...ts_files(SRC)
      .filter((p) => !p.endsWith(`${SRC}scoped.ts`))
      .map((path) => ({
        name: path.slice(SRC.length),
        text: readFileSync(path, "utf8"),
      })),
  ];

  it("is the only module that constructs an AsyncLocalStorage", () => {
    const offenders = outside_scoped
      .filter(({ text }) => /new AsyncLocalStorage/.test(code_of(text)))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("is the only module that runs or reads one", () => {
    // Callers ask for a runner or a reader (`make_run_scoped`,
    // `current_ports`, `make_reaction_scope`, `current_reacting`) so the
    // mechanics stay in one file.
    const offenders = outside_scoped
      .filter(({ text }) =>
        /\b(?:scoped|reacting)\.(?:run|getStore|enterWith)\(/.test(
          code_of(text)
        )
      )
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });
});

describe("architecture: ambient mechanisms are not public API", () => {
  it("does not publish the ports AsyncLocalStorage", () => {
    // `index.ts` star-exports `ports.ts`, so anything ports.ts exports is
    // published. The `Scoped` TYPE is public on purpose (it types
    // `ActOptions.scoped`) and lives in types/. The instance is not.
    const ports = code_of(readFileSync(join(SRC, "ports.ts"), "utf8"));
    expect(ports).not.toMatch(/export \{[^}]*\bscoped\b[^}]*\}/);
    const types = code_of(readFileSync(join(SRC, "types", "act.ts"), "utf8"));
    expect(types).toMatch(/export type Scoped = /);
  });
});

describe("architecture: PII stays inside the modules that own it", () => {
  const SENSITIVE = join(SRC, "internal", "pii.ts");
  const OWNER = join(SRC, "builders", "event-builder.ts");

  it("is composed in exactly one place", () => {
    // `internal/pii.ts` declares the transforms;
    // `event-builder.ts` composes them into readers at build. A third module
    // reaching for `pii_split` / `pii_strip` / `pii_gate` / `make_gate` means
    // the composition has leaked back out to a caller — which is how it was
    // spread across act-builder before (#1556).
    const offenders = ts_files(SRC)
      .filter((p) => p !== SENSITIVE && p !== OWNER)
      .map((path) => ({
        name: path.slice(SRC.length),
        text: readFileSync(path, "utf8"),
      }))
      .filter(({ text }) =>
        /\b(pii_split|pii_gate|make_gate)\s*\(/.test(code_of(text))
      )
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("publishes only what another package genuinely needs", () => {
    // `pii_fields` IS public: act-http's OpenAPI emitter marks request-body
    // properties `writeOnly` with it (auto-generated-api.md). The transforms
    // are not — publishing them would invite a caller to redact by hand.
    const schemas = code_of(
      readFileSync(join(SRC, "types", "schemas.ts"), "utf8")
    );
    expect(schemas).toMatch(/export \{ pii_fields \}/);
    expect(schemas).not.toMatch(/\bpii_(split|gate|strip)\b/);
  });
});
