# book/

Working notes for the eventual **Act book** — long-form, narrative material
that doesn't belong in API docs, design discussions, or `PERFORMANCE.md`
ledgers but is worth preserving while it's fresh.

Each file is a self-contained essay tied to a specific change. They're
written for a reader who knows event sourcing but doesn't know Act, and
who wants the *why* behind a decision rather than the *what*.

The book itself is not yet structured. When it is, these essays will be
mined for material — sometimes verbatim, often as the seed for a longer
chapter. Until then, the goal is to capture the reasoning while the
trade-offs are still in the author's head.

## Conventions

- One file per change, named after the ticket (e.g. `act-402-contracts-cli.md`).
- Open with the **problem in one paragraph** — what hurt before the change.
- Show the **wrong turns** the design took, not just the one that won.
  Future readers learn from the rejected paths.
- Cross-reference the relevant source files and PR; assume both will move.

The audience is a future contributor, possibly an LLM, definitely not
the original author six months from now.
