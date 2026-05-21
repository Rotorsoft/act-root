# @rotorsoft/act-diagram

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act-diagram.svg)](https://www.npmjs.com/package/@rotorsoft/act-diagram)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act-diagram.svg)](https://www.npmjs.com/package/@rotorsoft/act-diagram)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

_Interactive domain model diagram for [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act). Reads your TypeScript, renders an SVG of states, slices, projections, and reactions — with click-through to source._

## Why this package

Act apps grow horizontally — more states, more slices, more projections, more reactions — and at some point the mental model of "what fires what" stops fitting in your head. This package solves that two ways:

A **React component** that renders the live domain model as an interactive SVG, with click-to-source navigation. Drop it into an IDE webview (VS Code, Cursor, Neovim via [`act-nvim`](https://github.com/Rotorsoft/act-nvim)), a docs site, or a standalone explorer. Per-slice error isolation means a broken file shows its error in the slice boundary while healthy slices keep rendering.

A **terminal CLI** (`act`) that walks the same parsed model interactively, surfaces captured Zod schemas, flags deprecation via the `_v<n>` convention, and jumps into `$EDITOR` at the exact `file:line`. Use it when you want the structural answer ("who emits `TicketOpened`?") without leaving the terminal.

Both reuse the same extraction pipeline — mock builders + Sucrase transpile — so the diagram and the CLI always agree.

## Installation

```bash
pnpm add @rotorsoft/act-diagram
```

The React component ships its own stylesheet — import it once at your host's entry point:

```ts
import "@rotorsoft/act-diagram/styles.css";
```

The CLI ships as the `act` bin:

```bash
npx -p @rotorsoft/act-diagram act
# or, in a workspace that depends on it:
pnpm act
```

## Quick start

### React component

```tsx
import { ActDiagram } from "@rotorsoft/act-diagram";
import "@rotorsoft/act-diagram/styles.css";

function App() {
  return (
    <ActDiagram
      files={[
        { path: "src/states.ts", content: "..." },
        { path: "src/app.ts", content: "..." },
      ]}
      onNavigate={(file, line, col) => {
        console.log(`open ${file}:${line}:${col}`);
      }}
    />
  );
}
```

### CLI

```bash
pnpm act                          # interactive: pick category → entry → detail
pnpm act packages/wolfdesk        # target a specific package
pnpm act -q TicketOpened          # non-interactive: print one entity, exit
```

Interactive mode uses arrow-key navigation ([`@clack/prompts`](https://github.com/natemoo-re/clack)). Each entry shows producers, consumers, captured Zod schema text, deprecation status, and a one-key shortcut to open the source in `$EDITOR` (VS Code, Cursor, vim, nvim, nano, emacs all recognized). `-q <name>` is the script-friendly path — exits 0 with the detail on a single match, 0 with the match list on ambiguity, 1 with no matches. CI smoke-tests parsing with this mode.

## API

### React components

| Component | Purpose |
|---|---|
| `ActDiagram` | Standalone wrapper — pipeline + diagram + optional AI bar. `onNavigate(file, line, col, type?)` for click-to-source. |
| `Diagram` | Raw SVG diagram with pan/zoom/model tree/warnings. Use when you want to drive the pipeline yourself. |
| `AiBar` | Resizable prompt input with model and token controls (optional refinement bar). |
| `Logo`, `Tooltip` | Small UI primitives used inside the diagram, exported for host reuse. |

### Functions

| Function | Purpose |
|---|---|
| `extractModel(files)` | High-level extract: `topoSort` + `buildModel`. Returns `{ model, error? }`. |
| `buildModel(files)` | Lower-level: transpile + execute per-file, returns merged inventory + per-file errors. |
| `validate(model)` | Check for missing emits, orphan reactions, etc. Returns `ValidationWarning[]`. |
| `navigateToCode(files, name, type?)` | Pure function — find `{ file, line, col }` for a named element. |
| `topoSort(files)` | Sort files by import dependency order. |
| `computeLayout(model)` | Pure layout — positions nodes, edges, slice boxes. |
| `emptyModel()` | Construct an empty `DomainModel`. |
| `parseMultiFileResponse(text)`, `stripFences(text)`, `deriveProjectName(files)` | AI-pipeline helpers used by `ActDiagram` when `onAiRequest` is wired. |

### IDE plugin protocol (postMessage)

```ts
// Host → Diagram
type HostMessage =
  | { type: "files"; files: FileTab[] }
  | { type: "fileAdded"; path: string; content: string }
  | { type: "fileChanged"; path: string; content: string }
  | { type: "fileDeleted"; path: string };

// Diagram → Host
type DiagramMessage =
  | { type: "navigate"; file: string; line: number; col: number }
  | { type: "aiRequest"; prompt: string; files: FileTab[] };
```

Full type reference: [typedoc](https://github.com/Rotorsoft/act-root/blob/master/docs/docs/api/act-diagram/src/README.md).

## Common patterns

### IDE webview (postMessage)

```tsx
<ActDiagram usePostMessage onNavigate={handleNavigate} />
```

```ts
// From the extension host:
webview.postMessage({ type: "files", files: [...] });
webview.postMessage({ type: "fileChanged", path: "src/app.ts", content: "..." });
```

The webview side picks up host messages automatically when `usePostMessage` is set; the diagram emits `navigate` and `aiRequest` back through `window.parent.postMessage`.

### Bring-your-own pipeline

```tsx
import { Diagram, extractModel, validate } from "@rotorsoft/act-diagram";

const { model } = extractModel(files);
const warnings = validate(model);

<Diagram
  model={model}
  warnings={warnings}
  onClickElement={(name, type, file) => {/* … */}}
/>
```

Use when you want to cache the extracted model, run extraction in a worker, or wire it to a non-standard file source.

### Optional AI refinement

The `AiBar` component dispatches refinement prompts to a streaming endpoint. A reference SSE server lives at `src/server/server.ts` (port 4002) and forwards prompts to Anthropic's API:

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm -F @rotorsoft/act-diagram dev:server
```

In your host:

```tsx
<ActDiagram
  onAiRequest={(prompt, files) =>
    fetch("http://localhost:4002/api/generate", { /* … */ })
  }
/>
```

The reference server is a thin SSE relay — bring your own API key, model selection, and prompt strategy. AI mode is opt-in: omit `onAiRequest` and the `AiBar` doesn't render.

### Neovim integration

[`@rotorsoft/act-nvim`](https://github.com/Rotorsoft/act-nvim) renders this diagram in the browser with bidirectional navigation, live refresh, and LSP diagnostic forwarding. The diagram is launched from inside Neovim; you click an element in the browser and the cursor jumps to the corresponding source line.

## How it works

The extraction pipeline uses mock versions of `state()`, `slice()`, `projection()`, and `act()` that capture the builder structure without needing the real framework runtime. Code is transpiled with [Sucrase](https://github.com/alangpierce/sucrase) and evaluated in an isolated scope.

Bottom-up: inventory scan → per-state validation → per-slice composition (with error isolation) → projection extraction → `act()` composition. Every item from the inventory is always displayed — with a diagram on success, or an error box on failure. Standalone states without a slice land in a synthetic "global" slice so nothing gets dropped.

## Compatibility

- **Node**: >=22.18.0
- **Peer**: `react` ^18 || ^19, `react-dom` ^18 || ^19, `zod` ^4.4.3
- **Bundled deps**: `lucide-react`, `sucrase`
- **CLI**: works from any project where the package is installed; recognizes `$VISUAL` / `$EDITOR` (vim, nvim, nano, emacs, VS Code, Cursor)
- **Browser**: the component is a React SPA — runs in any browser that supports modern ES (the host's bundler picks the target)
- **400+ tests** covering extraction, layout, navigation, CLI, error paths

## Stability

Public API governed by the [Act Stability Charter](../../STABILITY.md). The diagram's **output shape** (SVG structure, click-through anchors) is *not* part of the stability surface and may evolve. Charter is **in effect as of 1.0.0**; the milestone tracker is [milestone 1.0](https://github.com/Rotorsoft/act-root/milestone/1).

## Related packages

- **[@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act)** — the framework whose builders this parses (`state`, `slice`, `projection`, `act`).
- **[@rotorsoft/act-inspector](https://github.com/rotorsoft/act-root/tree/master/packages/inspector)** — runtime observatory (sibling to this build-time tool). Inspector shows live events + drain state; diagram shows the structural contract.

## Documentation

- **[Contracts CLI guide](https://rotorsoft.github.io/act-root/docs/guides/contracts-cli)** — full reference for the `act` CLI's interactive and non-interactive modes.
- **[State management](https://rotorsoft.github.io/act-root/docs/concepts/state-management)** — how the builders this parses compose into an app.
- **[`act-nvim`](https://github.com/Rotorsoft/act-nvim)** — Neovim integration repo.

## License

MIT
