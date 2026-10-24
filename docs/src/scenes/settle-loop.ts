import type { SceneSpec } from "../components/Scene";

/** settle(): one debounced cycle of correlate → drain passes (correlation-and-drain.md). */
const scene: SceneSpec = {
  title: "One settle catches up",
  participants: [
    { id: "app", label: "app.do()", kind: "action" },
    { id: "settle", label: "settle", kind: "state" },
    { id: "correlate", label: "correlate", kind: "reaction" },
    { id: "drain", label: "drain", kind: "reaction" },
    { id: "store", label: "store", kind: "store" },
  ],
  steps: [
    {
      say: "Three actions commit in quick succession, and each one asks for a settle.",
      messages: [
        { from: "app", to: "settle", label: "settle()" },
        { from: "app", to: "settle", label: "settle()" },
        { from: "app", to: "settle", label: "settle()" },
      ],
    },
    {
      say: "The debounce folds them into one cycle. The first call sets when the pass runs; later calls join it and never put it off, and a shorter `debounceMs` would only bring it forward.",
      notes: [{ at: "settle", text: "one cycle" }],
    },
    {
      say: "Pass 1 starts with correlate. It reads the events past its checkpoint and raises the work mark of every target a reaction resolves to.",
      messages: [
        { from: "settle", to: "correlate", label: "correlate()" },
        { from: "correlate", to: "store", label: "read, subscribe" },
      ],
    },
    {
      say: "Then drain claims the marked streams and runs their reactions. The reactions commit new events of their own.",
      messages: [
        { from: "settle", to: "drain", label: "drain()" },
        { from: "drain", to: "store", label: "claim, handle, ack" },
      ],
      notes: [
        {
          at: "settle",
          text: "progress: read 3 events,\nleased 2 streams",
          tone: "good",
        },
      ],
    },
    {
      say: "The pass made progress, so settle loops. Pass 2's correlate finds the events the reactions just committed.",
      messages: [
        { from: "settle", to: "correlate", label: "correlate()" },
        { from: "correlate", to: "store", label: "read, subscribe" },
        { from: "settle", to: "drain", label: "drain()" },
        { from: "drain", to: "store", label: "claim, handle, ack" },
      ],
      notes: [
        {
          at: "settle",
          text: "progress: read 2 events,\nleased 1 stream",
          tone: "good",
        },
      ],
    },
    {
      say: "Pass 3 reads no events and leases nothing. That's the only kind of pass that ends the loop.",
      messages: [
        { from: "settle", to: "correlate", label: "correlate()" },
        { from: "settle", to: "drain", label: "drain()" },
      ],
      notes: [{ at: "settle", text: "no progress: stop", tone: "muted" }],
    },
    {
      say: "Settle emits `settled` once, with what every pass drained merged together.",
      messages: [
        { from: "settle", to: "app", label: "emit settled", tone: "good" },
      ],
    },
  ],
};
export default scene;
