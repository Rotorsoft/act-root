# act-nvim

Neovim plugin that renders interactive [Act](https://github.com/rotorsoft/act-root) event-sourcing diagrams in your browser with bidirectional navigation.

Click a node in the diagram and Neovim jumps to the source definition. Edit code in Neovim and the diagram updates live as you type.

## Quick Start

### 1. Build the plugin (once)

```bash
pnpm -F act-nvim build
```

This builds the relay server and the browser client into `dist/`.

### 2. Add to your Neovim config

**lazy.nvim (local path):**

```lua
{
  dir = "~/Projects/act/packages/act-nvim",
  config = function()
    require("act-nvim").setup()
  end,
}
```

**Manual runtimepath** (add to `init.lua`):

```lua
vim.opt.runtimepath:append("~/Projects/act/packages/act-nvim")
require("act-nvim").setup()
```

### 3. Use it

Open Neovim anywhere and run:

```vim
:ActDiagram ~/Projects/act/packages/wolfdesk
```

That's it. The plugin automatically:
- Starts the relay server (if not already running)
- Scans all `.ts`/`.tsx` files in the target directory
- Opens the diagram in your default browser
- Connects everything together
- Stops the relay when you quit Neovim

To switch to a different project without restarting:

```vim
:ActDiagram ~/Projects/act/packages/calculator
```

To stop manually (without quitting Neovim):

```vim
:ActDiagramClose
```

### Quick test from the monorepo

Without any Neovim config changes:

```bash
# From the repo root
pnpm -F act-nvim nvim packages/wolfdesk
```

This launches Neovim with the plugin loaded and immediately opens the wolfdesk diagram.

## How It Works

```
Neovim (Lua) <--TCP--> Node.js Relay <--WebSocket--> Browser (React)
   :4011                  :4010                        ActDiagram
```

- **Relay server** — Serves the diagram SPA, bridges Neovim and browser, watches the filesystem for changes
- **Browser client** — Full interactive SVG diagram with pan/zoom using `@rotorsoft/act-diagram`
- **Lua plugin** — Manages the relay lifecycle, sends file updates, handles navigation events

The relay starts automatically when you run `:ActDiagram` and stops when you quit Neovim. If a relay is already running externally (e.g. via `pnpm start`), the plugin connects to it instead of spawning a new one — and leaves it running when Neovim exits.

## Features

- **Click-to-navigate** — Click any action, event, state, reaction, guard, or projection in the diagram. Neovim jumps to the definition and highlights the word.
- **Live refresh** — Diagram updates as you type (500ms debounce). No need to save.
- **Extraction errors** — When code has syntax errors, the browser shows the error message instead of silently failing.
- **Browser tab reuse** — Only one tab is opened per session. Restarting Neovim reuses the existing tab.
- **Multi-project** — Switch between projects with `:ActDiagram <path>` without restarting.

## Commands

| Command | Description |
|---|---|
| `:ActDiagram [path]` | Open diagram for `path` (or cwd if omitted). Starts relay if needed. |
| `:ActDiagramClose` | Disconnect and stop the relay server. |

## Configuration

```lua
require("act-nvim").setup({
  tcp_port = 4011,      -- TCP port for Neovim <-> relay
  http_port = 4010,     -- HTTP/WS port for browser <-> relay
  auto_refresh = true,  -- live refresh on text changes
})
```

### Environment Variables (relay server)

| Variable | Default | Description |
|---|---|---|
| `ACT_NVIM_HTTP_PORT` | `4010` | HTTP + WebSocket port |
| `ACT_NVIM_TCP_PORT` | `4011` | TCP port for Neovim |

## npm Scripts

| Script | Description |
|---|---|
| `pnpm build` | Build relay server + browser client to `dist/` |
| `pnpm start` | Build and start the relay (for running it manually) |
| `pnpm dev` | Start relay in watch mode (for plugin development) |
| `pnpm nvim [path]` | Launch Neovim with plugin loaded, open diagram for `path` |
| `pnpm clean` | Remove `dist/` |

## Requirements

- Node.js >= 22.18.0
- Neovim >= 0.10
- pnpm >= 10.32.1 (for building)

## Troubleshooting

### Ports in use

```bash
lsof -i :4010
lsof -i :4011
```

Override with environment variables or config:

```lua
require("act-nvim").setup({ tcp_port = 5011, http_port = 5010 })
```

### Relay won't start automatically

Ensure the plugin is built (`dist/` exists):

```bash
pnpm -F act-nvim build
```

The plugin looks for `dist/server/relay.js` first, then falls back to running from source via `npx tsx`.

### Diagram is empty

The target directory may not contain Act state/slice/projection definitions. Only `.ts` and `.tsx` files are scanned (excluding `node_modules`, `dist`, `.git`, `coverage`, and `.d.ts` files).

### Extraction error shown

This means the code has issues that prevent model extraction. Fix the TypeScript errors shown in the error bar and the diagram will update automatically.

## File Structure

```
packages/act-nvim/
├── src/
│   ├── server/
│   │   ├── relay.ts        # HTTP + WS + TCP relay
│   │   └── watcher.ts      # File scanner + fs.watch
│   └── client/
│       ├── main.tsx         # WS-connected diagram with error display
│       └── styles.css       # Tailwind entry
├── lua/
│   └── act-nvim/
│       ├── init.lua         # Plugin entry: setup(), commands, autocmds
│       ├── tcp.lua          # vim.uv TCP client + NDJSON buffering
│       └── config.lua       # Default configuration
├── scripts/
│   └── nvim.mjs            # Helper to launch Neovim with plugin loaded
├── dist/                    # Built output
│   ├── server/relay.js
│   └── client/              # Bundled React SPA
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vite.config.ts
└── index.html
```

## Protocol

### Neovim -> Relay (TCP, newline-delimited JSON)

```jsonc
{ "type": "init", "root": "/absolute/path/to/project" }
{ "type": "fileChanged", "path": "src/app.ts", "content": "..." }
```

### Relay -> Neovim (TCP, newline-delimited JSON)

```jsonc
{ "type": "status", "browserConnected": true }
{ "type": "browserConnected" }
{ "type": "navigate", "file": "src/app.ts", "line": 24, "col": 7 }
{ "type": "error", "message": "scan failed: ENOENT ..." }
```

### Relay <-> Browser (WebSocket)

Standard `HostMessage` / `DiagramMessage` from `@rotorsoft/act-diagram`.
