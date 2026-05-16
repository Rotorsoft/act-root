---
description: Scaffold a book essay for a ticket, following the project's narrative style
argument-hint: "<ticket-id> <topic>"
allowed-tools: Read, Write
---

Create a new file at `book/$ARGUMENTS.md` (the user provides `<ticket-id>-<slug>`) and scaffold an essay in the project's narrative voice.

## Style rules (from `book/README.md` and the existing essays)

- One file per change, named after the ticket: `act-602-act-http.md`, `act-604-non-retryable.md`, etc.
- Open with **the problem in one paragraph** — what hurt before the change.
- Show **the wrong turns** the design took, not just the one that won. Future readers learn from the rejected paths.
- Cross-reference relevant source files and PR.
- Audience: future contributor (possibly an LLM), not the author six months from now.

## Voice — based on feedback memory `feedback_book_style.md`

- Narrative storytelling, not bullet-pointed reference.
- No em-dashes for emphasis ("X — Y"). Use prose.
- No "Here's how X works:" followed by a list. Use flowing paragraphs.
- No bolded keyword lists for definitions. Explain through scenarios.
- Read it aloud — if it sounds like a robot wrote it, rewrite it.

## Structure to seed

Use these headers as a starting skeleton, then write prose under each:

```md
# ACT-XXX — <one-line topic>

## The pain that started it

(One paragraph: what hurt before this change. Reference the specific
moment the gap became visible.)

## Why the obvious answer didn't fit

(One or two paragraphs walking through the design alternative that
looked right but didn't work. Name the trade-offs.)

## The decision

(The shape that shipped. Code samples drawn from the actual PR, not
hypothetical.)

## What this teaches

(One paragraph distilling the principle. Forward-link to other essays
or chapters where the same pattern shows up.)

## Connections to other chapters
```

## Steps

1. Parse `$ARGUMENTS` as `<ticket-id> <slug>` (e.g., `act-605 retry-after`).
2. Create `book/$ARGUMENTS.md` with the skeleton above as a starting point.
3. Pre-fill the title line with `# ACT-XXX — <slug as title-case sentence>`.
4. Leave the body sections as placeholders. The user fills them in afterwards (or asks Claude to draft them based on a PR diff).
