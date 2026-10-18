---
id: flow-animations
title: Flow animations
description: Turn an Act app's builders into an animated, interactive map of every action, state check, event, reaction and timer, then publish it or export a video.
sidebar_position: 3.6
---

# Flow animations

An Act app already knows its own flows. Every action, the state that checks it, the events it commits, the projections that fold them and the reactions that pick them up are declared in the builders. A flow animation draws all of that as one map and plays it: a token leaves a person or an automation, passes through the state where the invariants are checked, lands as an event, feeds the projections, wakes a reaction, and goes on to the next action or out to another system.

**See one:** [WolfDesk ticket flows](pathname:///flows/wolfdesk.html) · [all animations](pathname:///flows/index.html)

## What you get

- **The whole model on one screen.** Swimlanes for actors, actions, state, events, projections, reactions and the outside world. Time runs left to right. Select any box for its invariants, schema, source file and neighbors.
- **Scenarios that cover every flow.** Each tab plays one story. Together they walk every connection on the map, including the ones people forget to show: refused actions, retries with backoff, a blocked target, and timers that wake and do nothing.
- **The state and the stream, live.** The right rail shows the event stream as it grows (global id, stream version, and the person or automation that caused each event) and the state as each event patches it.
- **Video.** One script exports a 1080p MP4 per scenario for talks, READMEs and release notes.
- **One static file.** No build, no server. It runs on GitHub Pages, any static host, or inside an iframe.

## Make one with Claude Code

The repo ships an `animate-act-flows` skill. Ask for it in plain words:

```text
animate the flows of packages/wolfdesk
```

The skill does four things:

1. **Extracts a draft.** It runs the same parser as the [`act` CLI](./contracts-cli.md) over your builders and gets states, actions, invariants, events, reactions and projections.
2. **Reads the source.** The parser is best-effort, so the skill fills in what it can't see: actions invoked from helper functions, `webhook()` reactions, `.defer` timers, calls to outside services, and who the actors are (people, or automations such as the actor a reaction runs as).
3. **Writes the scenarios.** Short, believable stories, each showing one mechanism, until every connection is covered.
4. **Saves the spec.** The result is one JSON file, `docs/flows/<app>.flow.json`.

## Preview it

```bash
pnpm -F docs flows                 # validate every spec and render docs/static/flows/
open docs/static/flows/wolfdesk.html
```

The build refuses a spec whose scenario walks a connection the map doesn't draw, and warns about connections no scenario walks.

Controls: space plays or pauses, the arrow keys step, and the tabs switch scenarios. The legend and the "how to read" notes float and close. Panels on the right collapse.

## Publish it

Commit the spec and merge it. `docs/flows/*.flow.json` is part of the docs build (`pnpm -F docs build:all`), so the next docs deploy publishes the page at `/flows/<app>.html` and adds it to the [gallery](pathname:///flows/index.html). To publish without waiting for another docs change, run the **Deploy Docusaurus Docs** workflow by hand from the Actions tab.

To host it somewhere else, render a standalone file:

```bash
node docs/scripts/flows.mjs render docs/flows/wolfdesk.flow.json wolfdesk.html --standalone
```

## Export a video

```bash
pnpm -F docs flows:video wolfdesk --scenario 2 --out escalation.mp4
```

| Option | Default | Meaning |
|---|---|---|
| `--scenario n` | all, back to back | Which tab to record (1-based) |
| `--size WxH` | `1920x1080` | Video size |
| `--theme dark\|light` | `dark` | Color theme |
| `--speed x` | `1` | Playback speed |
| `--out file` | `<app>[-n].mp4` | Output path |

It drives Chrome through `playwright-core`, captures every frame the page paints and encodes H.264 with `ffmpeg`. You need Chrome and `ffmpeg` installed.

The hosted page also has a **Record** button. In Chrome it captures the tab while the current scenario plays and saves the file.

## Link or embed

The page reads a few words from the URL fragment, joined with `-`:

| Fragment | Effect |
|---|---|
| `#s3` | Open on the third scenario |
| `#dark`, `#light` | Force a theme |
| `#embed` | Hide the title and extra buttons, loop all scenarios. For iframes |
| `#record` | Hide the controls and play once. Used by the video export |

```html
<iframe src="https://rotorsoft.github.io/act-root/flows/wolfdesk.html#embed" width="100%" height="640" loading="lazy"></iframe>
```

## The spec

The player is generic. All app knowledge lives in the spec: lanes, nodes with a column, edges, and scenarios made of steps. A step either walks an edge (`from`, `to`) or stands at a node (`at`). Steps can carry the event `data`, the state `patch`, a `wait` for timers, a `reject` reason, `retries` with `backoff`, and `blocked`. The skill's `SKILL.md` documents every field, and [`docs/flows/wolfdesk.flow.json`](https://github.com/rotorsoft/act-root/blob/master/docs/flows/wolfdesk.flow.json) uses all of them.
