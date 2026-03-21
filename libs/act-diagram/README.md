# @rotorsoft/act-diagram

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act-diagram.svg)](https://www.npmjs.com/package/@rotorsoft/act-diagram)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act-diagram.svg)](https://www.npmjs.com/package/@rotorsoft/act-diagram)
[![Build Status](https://github.com/rotorsoft/act-root/actions/workflows/ci-cd.yml/badge.svg?branch=master)](https://github.com/rotorsoft/act-root/actions/workflows/ci-cd.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Interactive domain model diagram for [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act) event-sourced apps. Extracts states, actions, events, reactions, slices, and projections from TypeScript source code and renders them as an interactive SVG.

## Goals

1. **Real-time visualization** — SVG diagram updates as source files change
2. **Code navigation** — click any diagram element to get its `file:line:col` location
3. **IDE-agnostic** — no VS Code, Monaco, or editor coupling; works over props, postMessage, or WebSocket
4. **Embeddable** — use as a React component in any host (IDE webview, standalone app, docs site)
5. **AI refinement** — optional prompt bar to generate code via a streaming endpoint

## Installation

```sh
npm install @rotorsoft/act-diagram
# or
pnpm add @rotorsoft/act-diagram
```

**Peer dependencies:** `react >= 18`, `react-dom >= 18`

## How It Works

```
  TypeScript files (.ts)
        |
        v
  topoSort()          ← order files by import dependencies
        |
        v
  extractModel()      ← transpile + execute with mock builders → DomainModel
        |               (fallback: regex extraction for broken files)
        v
  validate()           ← check for missing emits, orphan reactions, etc.
        |
        v
  <Diagram />          ← SVG layout: slices, states, actions, events, reactions
        |
        v
  navigateToCode()     ← click element → { file, line, col }
```

The extraction pipeline uses mock versions of `state()`, `slice()`, `projection()`, and `act()` that capture the builder structure without needing the real framework runtime. Code is transpiled with [Sucrase](https://github.com/alangpierce/sucrase) and evaluated in an isolated scope with `new Function()`.

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
        // Open file in your editor at this position
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
webview.postMessage({ type: "fileDeleted", path: "src/old.ts" });
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
  toolbarExtra={<MyCustomButtons />}
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
| `ActDiagram` | `files?`, `onNavigate?`, `usePostMessage?`, `onAiRequest?`, `generating?` | Standalone wrapper: pipeline + diagram + optional AI bar |
| `Diagram` | `model`, `warnings`, `onClickElement?`, `toolbarExtra?` | Raw SVG diagram with pan/zoom/model tree |
| `AiBar` | `onSubmit`, `generating?` | Prompt input for AI code generation |
| `Logo` | `size?` | Act logo SVG |
| `Tooltip` | `title`, `description?`, `details?`, `children`, `position?`, `align?` | Hover tooltip |

### Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `extractModel` | `(files: FileTab[]) => { model: DomainModel; error?: string }` | Extract domain model from TypeScript source files |
| `validate` | `(model: DomainModel) => ValidationWarning[]` | Validate model for missing emits, etc. |
| `navigateToCode` | `(files, name, type?, targetFile?) => { file, line, col } \| undefined` | Find source location of a named element |
| `topoSort` | `(files: FileTab[]) => FileTab[]` | Sort files by import dependency order |
| `parseMultiFileResponse` | `(raw: string) => FileTab[]` | Parse AI response with path-annotated fenced blocks |
| `stripFences` | `(code: string) => string` | Remove markdown fences from code |
| `deriveProjectName` | `(prompt, code?) => string` | Derive a project name from prompt or code |
| `emptyModel` | `() => DomainModel` | Create an empty domain model |

### Types

```typescript
type FileTab = { path: string; content: string };

type DomainModel = {
  entries: EntryPoint[];
  states: StateNode[];
  slices: SliceNode[];
  projections: ProjectionNode[];
  reactions: ReactionNode[];
  orchestrator?: ActNode;
};

type StateNode = { name, varName, events: EventNode[], actions: ActionNode[], file?, line? };
type ActionNode = { name, emits: string[], invariants: string[], line? };
type EventNode = { name, hasCustomPatch: boolean, line? };
type SliceNode = { name, states: string[], stateVars: string[], projections: string[], reactions: ReactionNode[], line? };
type ProjectionNode = { name, varName, handles: string[], line? };
type ReactionNode = { event, handlerName, dispatches: string[], isVoid: boolean, line? };
type ValidationWarning = { message, severity: "warning" | "error", element? };
```

### IDE Plugin Protocol

```typescript
// Host → Diagram (via postMessage or props)
type HostMessage =
  | { type: "files"; files: FileTab[] }
  | { type: "fileChanged"; path: string; content: string }
  | { type: "fileDeleted"; path: string };

// Diagram → Host (via onNavigate callback or postMessage)
type DiagramMessage =
  | { type: "navigate"; file: string; line: number; col: number }
  | { type: "aiRequest"; prompt: string; files: FileTab[] };
```

## AI Server (optional)

A minimal streaming endpoint for AI code generation:

```sh
# Start the AI server
ANTHROPIC_API_KEY=sk-... pnpm -F @rotorsoft/act-diagram dev:server
```

Single endpoint: `POST /api/generate` with SSE response.

```typescript
// Request
{ prompt: string; currentFiles?: FileTab[]; model?: string; maxTokens?: number; refine?: boolean }

// SSE events
{ type: "text", text: "..." }
{ type: "done", truncated: boolean, usage: {...} }
{ type: "error", message: "..." }
```

## Development

```sh
# Visual dev server with sample diagram
pnpm -F @rotorsoft/act-diagram dev

# Run tests
pnpm -F @rotorsoft/act-diagram test

# Build library
pnpm -F @rotorsoft/act-diagram build
```

## Related

- [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act) - Core framework
- [@rotorsoft/act-pg](https://www.npmjs.com/package/@rotorsoft/act-pg) - PostgreSQL adapter
- [@rotorsoft/act-sse](https://www.npmjs.com/package/@rotorsoft/act-sse) - SSE state broadcast
- [@rotorsoft/act-patch](https://www.npmjs.com/package/@rotorsoft/act-patch) - Deep merge patches
- [Documentation](https://rotorsoft.github.io/act-root/)

## License

[MIT](https://github.com/rotorsoft/act-root/blob/master/LICENSE)
