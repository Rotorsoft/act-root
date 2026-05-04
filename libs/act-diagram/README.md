# @rotorsoft/act-diagram

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act-diagram.svg)](https://www.npmjs.com/package/@rotorsoft/act-diagram)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act-diagram.svg)](https://www.npmjs.com/package/@rotorsoft/act-diagram)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Interactive domain model diagram for [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act) event-sourced apps. Extracts states, actions, events, reactions, slices, and projections from TypeScript source code and renders them as an interactive SVG.

## Features

- **Real-time visualization** — SVG diagram updates as source files change
- **Code navigation** — click any diagram element to jump to its `file:line:col` location
- **Per-slice error isolation** — broken files show errors in their slice boundary while healthy slices render normally
- **Bottom-up model building** — states → slices → act, each level independently validated
- **IDE-agnostic** — works over props, postMessage, or WebSocket (see [act-nvim](https://github.com/Rotorsoft/act-nvim) for Neovim integration)
- **Embeddable** — React component for any host (IDE webview, standalone app, docs site)
- **AI refinement** — optional prompt bar to generate code via a streaming endpoint (see [AI server](#ai-server-optional))
- **High test coverage** — over 300 tests covering extraction, layout, navigation, and error paths

## Installation

```sh
npm install @rotorsoft/act-diagram
# or
pnpm add @rotorsoft/act-diagram
```

**Peer dependencies:** `react >= 18`, `react-dom >= 18`

The component ships its own stylesheet — import it once at the host's entry point:

```ts
import "@rotorsoft/act-diagram/styles.css";
```

## How It Works

```
  TypeScript files (.ts)
        |
        v
  topoSort()          ← order files by import dependencies
        |
        v
  extractModel()      ← transpile + execute with mock builders → DomainModel
        |               inventory scan → per-state validation → per-slice error isolation
        v
  validate()           ← check for missing emits, orphan reactions, etc.
        |
        v
  computeLayout()      ← pure layout: positions nodes, edges, slice boxes, projections
        |
        v
  <Diagram />          ← SVG rendering with pan/zoom/model tree/errors section
        |
        v
  navigateToCode()     ← click element → { file, line, col }
```

### Extraction Pipeline

The extraction uses mock versions of `state()`, `slice()`, `projection()`, and `act()` that capture the builder structure without needing the real framework runtime. Code is transpiled with [Sucrase](https://github.com/alangpierce/sucrase) and evaluated in an isolated scope.

**Bottom-up model building:**

1. **Inventory** — scan source files for all `state()`, `slice()`, `projection()`, `act()` declarations
2. **Build states** — validate each state independently (detects undefined schemas from broken imports)
3. **Build slices** — compose states from step 2, track missing/corrupted references per slice
4. **Build projections** — extract projection handlers
5. **Compose act** — wire slices + projections + reactions into entries, standalone states into a "global" slice

Every item from the inventory is always displayed — with a diagram on success, or an error box on failure.

## Usage

### Standalone Component

```tsx
import { ActDiagram } from "@rotorsoft/act-diagram";

function App() {
  return (
    <ActDiagram
      files={[
        { path: "src/states.ts", content: "..." },
        { path: "src/app.ts", content: "..." },
      ]}
      onNavigate={(file, line, col) => {
        console.log(`Navigate to ${file}:${line}:${col}`);
      }}
    />
  );
}
```

### IDE Webview (postMessage)

```tsx
// In the webview
<ActDiagram usePostMessage onNavigate={handleNavigate} />

// From the IDE extension host
webview.postMessage({ type: "files", files: [...] });
webview.postMessage({ type: "fileChanged", path: "src/app.ts", content: "..." });
```

### Raw Diagram (bring your own pipeline)

```tsx
import { Diagram, extractModel, validate } from "@rotorsoft/act-diagram";

const { model } = extractModel(files);
const warnings = validate(model);

<Diagram
  model={model}
  warnings={warnings}
  onClickElement={(name, type, file) => { /* ... */ }}
/>
```

### Code Navigation (pure function)

```typescript
import { navigateToCode } from "@rotorsoft/act-diagram";

const result = navigateToCode(files, "OpenTicket", "action");
// → { file: "src/states.ts", line: 24, col: 7 }
```

## API

### Components

| Component | Props | Description |
|-----------|-------|-------------|
| `ActDiagram` | `files?`, `onNavigate?(file, line, col, type?)`, `usePostMessage?`, `onAiRequest?`, `generating?` | Standalone wrapper: pipeline + diagram + optional AI bar. `onNavigate`'s 4th argument carries the diagram element type (`state`, `slice`, `event`, …) for callers that want type-aware routing. |
| `Diagram` | `model`, `warnings`, `onClickElement?`, `onFixWithAi?`, `toolbarExtra?` | Raw SVG diagram with pan/zoom/model tree/warnings |
| `AiBar` | `onSubmit`, `generating?` | Resizable prompt input with model and token controls |
| `Logo` | `size?` | Act logo SVG |
| `Tooltip` | `title`, `description?`, `details?`, `children`, `position?`, `align?` | Hover tooltip |

### Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `extractModel` | `(files: FileTab[]) => { model: DomainModel; error?: string }` | Extract domain model from TypeScript source files (orchestrates `topoSort` + `buildModel`) |
| `buildModel` | `(files: FileTab[]) => ExecuteResult` | Lower-level: transpile + execute one file at a time, returns the merged inventory and per-file errors. Use when you want to drive the pipeline yourself |
| `validate` | `(model: DomainModel) => ValidationWarning[]` | Validate model for missing emits, etc. |
| `navigateToCode` | `(files, name, type?, targetFile?) => { file, line, col } \| undefined` | Find source location of a named element |
| `topoSort` | `(files: FileTab[]) => FileTab[]` | Sort files by import dependency order |
| `computeLayout` | `(model: DomainModel) => Layout` | Pure layout computation — positions all nodes, edges, and slice boxes |
| `emptyModel` | `() => DomainModel` | Create an empty domain model |
| `parseMultiFileResponse` | `(text: string) => FileTab[]` | Parse a multi-file AI response into individual `FileTab`s |
| `stripFences` | `(text: string) => string` | Strip Markdown code fences from a block — used by the AI pipeline to extract raw code |
| `deriveProjectName` | `(files: FileTab[]) => string` | Best-effort project name from the file set — used in the AI prompt context |

### Types

```typescript
type FileTab = { path: string; content: string };

type ExecuteResult = {
  model: DomainModel;
  errors: Record<string, string>; // keyed by file path
};

type DomainModel = {
  entries: EntryPoint[];
  states: StateNode[];
  slices: SliceNode[];
  projections: ProjectionNode[];
  reactions: ReactionNode[];
  orchestrator?: ActNode; // present only after `act()` is composed
};

type StateNode = { name, varName, events: EventNode[], actions: ActionNode[], file?, line? };
type ActionNode = { name, emits: string[], invariants: string[], line? };
type EventNode = { name, hasCustomPatch: boolean, line? };
type SliceNode = { name, states: string[], stateVars: string[], projections: string[], reactions: ReactionNode[], error?, file?, line? };
type ProjectionNode = { name, varName, handles: string[], line? };
type ReactionNode = { event, handlerName, dispatches: string[], line? };

// Layout types
type Box = { x, y, w, h, label, error? };
type Layout = { ns: N[], es: E[], boxes: Box[], minX, minY, width, height };
```

### IDE Plugin Protocol

```typescript
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

## AI server (optional)

The `AiBar` component dispatches refinement prompts to a streaming endpoint. The package ships with a reference server at `src/server/server.ts` (port 4002) that forwards prompts to Anthropic's API:

```sh
# In one terminal
ANTHROPIC_API_KEY=sk-ant-... pnpm -F @rotorsoft/act-diagram dev:server

# In your host app, pass onAiRequest to ActDiagram
<ActDiagram onAiRequest={(prompt, files) => fetch("http://localhost:4002/api/generate", { ... })} />
```

The reference server is a thin SSE relay — bring your own API key, your own model selection, and your own prompt strategy. AI mode is opt-in: omit `onAiRequest` and the `AiBar` doesn't render.

## Neovim Integration

See [@rotorsoft/act-nvim](https://github.com/Rotorsoft/act-nvim) — a Neovim plugin that renders act-diagram in the browser with bidirectional navigation, live refresh, and LSP diagnostic forwarding.

## Development

```sh
# Visual dev server with sample diagram
pnpm -F @rotorsoft/act-diagram dev

# Run the test suite
pnpm -F @rotorsoft/act-diagram test

# Build library
pnpm -F @rotorsoft/act-diagram build
```

## License

MIT
