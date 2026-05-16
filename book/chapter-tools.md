# Tools coverage — Inspector and Diagram as first-class development aids

Two Act framework tools should be woven into future chapters, not just mentioned in passing.

**Inspector** (`/packages/inspector`) — an event sourcing observatory. Run with `pnpm dev:inspector`, opens a web UI that connects to PostgreSQL event stores. Features: event log with filters (stream, event type, time range, correlation ID), timeline swimlane visualization, stream inspector, correlation explorer (waterfall + DAG for causation chains), processing monitor (drain health, blocked streams, lease status), and live polling mode. Read-only, React+tRPC. Auto-discovers Postgres instances on ports 5430-5480.

**Diagram** (`/libs/act-diagram`) — interactive domain model visualization. Extracts `state()`, `slice()`, `projection()`, `act()` definitions from TypeScript source and renders an SVG diagram in real time. Click elements to navigate to source. Integrates with nvim via `act-nvim` plugin. Can also run standalone with `pnpm -F @rotorsoft/act-diagram dev`. Has an AI refinement prompt bar for generating/fixing code.

These tools are part of what makes Act a complete framework, not just a library. The book should show readers how to use them as part of their development workflow.

**Placement:**
- Ch 4 (Event Store): introduce the Inspector as a way to see what's in the store
- Ch 8 (DDD): introduce the Diagram tool when discussing Event Storming → code mapping
- Ch 9 (Modeling Risk): use Diagram to visualize the game domain model
- Ch 14 (Operations): deep dive on Inspector for production monitoring (correlation explorer, processing monitor, timeline)
- Show screenshots/descriptions of both tools in relevant chapters
