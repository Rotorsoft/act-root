# Contributing

## Performance Optimization Workflow

Pattern used for Act framework performance tickets. Follow this process when creating and implementing optimization issues.

### Phase 1: Analysis

1. Deep-read the current implementation — all relevant source files with line numbers
2. Identify the bottleneck with specific code paths and data flow
3. Name the pattern being applied (e.g., "competing consumers", "cursor-based processing")
4. Map existing mechanisms (watermarks, frontiers, caches) before proposing new ones
5. Understand why the current approach works before changing it

### Phase 2: Issue Creation

Each issue should include:

- **Problem** — current behavior with code references, impact at scale
- **Pattern** — named pattern with explanation (e.g., `FOR UPDATE SKIP LOCKED`, cursor-based processing)
- **Strategy** — implementation approach with interface changes, SQL, and code sketches
- **Benchmarking plan** — specific scenarios to measure, before/after methodology
- **Documentation tasks** — CLAUDE.md, READMEs, Docusaurus, skills, PERFORMANCE.md
- **Acceptance criteria** — checklist including tests, docs, and benchmark results

### Phase 3: Implementation

- Present plan and get confirmation before coding
- Use short names matching existing vocabulary (`claim`, `subscribe`, `max_at`)
- Classify behaviors at build time when possible (static vs dynamic resolvers)
- Reuse existing mechanisms (watermarks as checkpoints) before creating new ones
- Keep the Store interface minimal — fold implementation details into existing methods
- Run tests after every change

### Phase 4: Benchmarking

- Write benchmarks that exercise the **exact scenario** being fixed
- Separate benchmarks per optimization dimension when a ticket solves multiple problems
- Run on master code (checkout source, build, run) for real before/after comparison
- Run on feature branch with same benchmark for after numbers
- Report honestly — if numbers are within noise, say so and explain the architectural value

### Phase 5: Documentation

- **`libs/act/PERFORMANCE.md`** — detailed benchmark tables, pattern explanation, before/after comparison
- **`libs/act/README.md`** — current patterns only, link to PERFORMANCE.md for history
- **`CLAUDE.md`** — Store Interface Contract, optimization notes
- **Docusaurus** — concept pages with optimization notes
- **Scaffold skills** — update production.md, act-api.md as needed
- Verify Docusaurus build passes before PR

### Key Principles

- Understand existing mechanisms deeply before proposing new ones
- Don't add to the Store interface unless strictly necessary — fold into existing methods
- Benchmarks must show real improvement in the specific scenario being fixed
- Multiple optimizations in one ticket need multiple benchmarks
- Document the pattern, not just the code — explain why it works
