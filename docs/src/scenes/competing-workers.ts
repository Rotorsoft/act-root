import type { SceneSpec } from "../components/Scene";

/** Two workers claim from one store with FOR UPDATE SKIP LOCKED (concurrency-model.md). */
const scene: SceneSpec = {
  title: "Two workers drain one store",
  participants: [
    { id: "a", label: "worker A", kind: "reaction" },
    { id: "store", label: "store", kind: "store" },
    { id: "b", label: "worker B", kind: "reaction" },
  ],
  steps: [
    {
      say: "Five streams have work: correlate raised their work mark above their watermark.",
      notes: [{ at: "store", text: "streams 1 2 3 4 5\nat < correlated_at" }],
    },
    {
      say: "Two worker processes claim at the same moment.",
      messages: [
        { from: "a", to: "store", label: "claim(by: A)" },
        { from: "b", to: "store", label: "claim(by: B)" },
      ],
    },
    {
      say: "A's claim locks the rows it takes. B's claim uses `FOR UPDATE SKIP LOCKED`, so it passes over A's rows instead of waiting for them.",
      notes: [
        { at: "store", text: "A locks 1, 3, 5\nB skips them, locks 2, 4" },
      ],
    },
    {
      say: "Each worker gets a lease on a different set of streams. No worker waits on another, and no stream is handled twice.",
      messages: [
        { from: "store", to: "a", label: "leases 1, 3, 5", tone: "good" },
        { from: "store", to: "b", label: "leases 2, 4", tone: "good" },
      ],
    },
    {
      say: "Both fetch their streams' events and run the reactions, in parallel.",
      messages: [
        { from: "a", to: "store", label: "fetch 1, 3, 5" },
        { from: "b", to: "store", label: "fetch 2, 4" },
      ],
      notes: [
        { at: "a", text: "handle" },
        { at: "b", text: "handle" },
      ],
    },
    {
      say: "Each acks its own leases: the watermarks advance and the leases are released. A worker that dies before acking loses nothing: its leases expire after `leaseMillis`, and any worker can claim those streams again.",
      messages: [
        { from: "a", to: "store", label: "ack 1, 3, 5" },
        { from: "b", to: "store", label: "ack 2, 4" },
      ],
      notes: [
        {
          at: "store",
          text: "watermarks advance\nleases released",
          tone: "good",
        },
      ],
    },
  ],
};
export default scene;
