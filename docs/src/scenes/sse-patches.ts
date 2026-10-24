import type { SceneSpec } from "../components/Scene";

/** Version-keyed SSE patches and the three client outcomes (real-time.md). */
const scene: SceneSpec = {
  title: "One commit reaches three clients",
  participants: [
    { id: "server", label: "server", kind: "action" },
    { id: "broadcast", label: "BroadcastChannel", kind: "projection" },
    { id: "a", label: "client at v7", kind: "actor" },
    { id: "b", label: "client at v5", kind: "actor" },
    { id: "c", label: "client at v9", kind: "actor" },
  ],
  steps: [
    {
      say: "`app.do()` commits two events, v8 and v9. Each snapshot carries the patch its event applied.",
      notes: [{ at: "server", text: "v8: patch 8\nv9: patch 9" }],
    },
    {
      say: "The server publishes the new state, with `_v` taken from the event version, and the two patches in commit order.",
      messages: [
        { from: "server", to: "broadcast", label: "publish(state, patches)" },
      ],
    },
    {
      say: "The channel caches the state for reconnects and keys each patch by its absolute version.",
      notes: [{ at: "broadcast", text: "{ 8: patch 8, 9: patch 9 }" }],
    },
    {
      say: "The same message goes to every subscriber.",
      messages: [
        { from: "broadcast", to: "a", label: "{ 8, 9 }" },
        { from: "broadcast", to: "b", label: "{ 8, 9 }" },
        { from: "broadcast", to: "c", label: "{ 8, 9 }" },
      ],
    },
    {
      say: "Each client calls `applyPatchMessage` against what it has. At v7, patch 8 comes right next: merge 8, then 9. At v5, versions 6 and 7 are missing, so it can't merge. At v9, it already has both.",
      notes: [
        { at: "a", text: "contiguous\nmerge → v9", tone: "good" },
        { at: "b", text: "behind\nmissed 6, 7", tone: "bad" },
        { at: "c", text: "stale\nskip", tone: "muted" },
      ],
    },
    {
      say: "The client that fell behind resyncs: it fetches the current state, and the next message lands contiguous.",
      messages: [
        { from: "b", to: "server", label: "fetch state" },
        { from: "server", to: "b", label: "state v9", tone: "good" },
      ],
    },
  ],
};
export default scene;
