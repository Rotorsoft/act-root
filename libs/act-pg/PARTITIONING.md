# Partitioning the events table

> **This page moved to [`/recipes/scaling/partitioning/`](../../recipes/scaling/partitioning/README.md).**

Partitioning is one of several operational recipes for Act applications that have outgrown the default storage path. It lives in the repo's [`recipes/`](../../recipes/README.md) folder alongside the other strategies (`.autocloses({...})` to retire streams, `.archives(...)` to ship history to cold storage before truncate, range-by-created partition drops for regulatory disposal).

The page that lived here is now the gating page at [`recipes/scaling/partitioning/README.md`](../../recipes/scaling/partitioning/README.md) — same content, plus the three strategy recipes split into their own folders with SQL templates and runnable shell wrappers:

- **HASH on `stream`** — [`recipes/scaling/partitioning/hash-on-stream/`](../../recipes/scaling/partitioning/hash-on-stream/README.md)
- **RANGE on `id`** (single-aggregate giants) — [`recipes/scaling/partitioning/range-on-id/`](../../recipes/scaling/partitioning/range-on-id/README.md)
- **RANGE on `created`** (bulk archival) — [`recipes/scaling/partitioning/range-on-created/`](../../recipes/scaling/partitioning/range-on-created/README.md)

Read the gating page first. Most Act applications don't need any of these — `.autocloses({...})` is the right answer for the dominant workload.
