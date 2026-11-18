# Doc-snippet type-checker

`check-snippets.mjs` tangles every fenced ` ```ts ` / ` ```typescript ` block
out of `docs/docs/**/*.{md,mdx}` into a gitignored temp dir
(`docs/.snippets/`) and type-checks the lot against the live
`@rotorsoft/act` source via `tsconfig.snippets.json`. It generalises the
single-file `docs/src/snippets/quickstart.ts` check to every inline snippet,
so shown code can't silently drift from the framework API (issue #1033).

## Commands

```bash
pnpm -F docs check:snippets          # extract + type-check (the CI gate)
pnpm -F docs snippets:extract        # extract only (writes docs/.snippets/)
pnpm -F docs check:snippets:selftest # negative test: a broken snippet must fail
node scripts/check-snippets.mjs --list   # print the extraction plan, write nothing
```

CI runs `check:snippets` (the gate) followed by `check:snippets:selftest`
(proves the gate isn't a no-op) on every PR that touches `docs/docs/**` or a
library's `src/**` — see the `ci` job in `.github/workflows/ci-cd.yml` and
`.github/workflows/docs-build.yml`. Pages under `docs/docs/api/` are typedoc
output and are not checked.

## Convention: marking intentionally-partial snippets

Snippets are type-checked **by default**. A block that is a deliberate
fragment — a method-chain excerpt, pseudo-code, a `...` elision, a
"don't do this" anti-example, or code that imports packages outside the
workspace — opts out by adding a skip marker to its info string:

````markdown
```ts no-check
.autocloses({ reaches: 10_000 })   // a fragment, not a standalone program
```
````

Recognised markers (any one, case-insensitive): `no-check`, `nocheck`,
`no-typecheck`, `skip-check`. The marker is part of the fence metadata, so it
is invisible in the rendered page — the highlighter still sees `ts`.

A block with **no** marker must be a self-contained program: it imports what
it uses and references no undefined symbols. If a real example fails the gate,
fix the snippet (it has drifted from the API); only reach for `no-check` when
the block was never meant to compile on its own.

# Tour narration

The tour at `/tour` speaks each sentence from a pre-rendered clip in
`docs/static/tour/voice/<key>.m4a`, where `key` is the first 12 hex characters
of the sentence's sha1. The page bundles the sentence-to-key list,
`src/tours/framework-tour.voice.json`. A line without a clip shows its caption
in silence, and `tour:lines --check` (run by the docs build) fails until it is
recorded.

```bash
pnpm -F docs tour:lines   # write src/tours/framework-tour.voice.json from the tour spec
.venv/bin/python docs/scripts/tour-voice.py --model <dir>   # render new lines with Kokoro
```

`tour-voice.py` renders only lines without a clip and deletes clips no line
names, so editing a sentence re-records just that sentence. Its docstring has
the one-time Kokoro setup; the model stays outside the repo.
