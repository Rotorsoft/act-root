import type { SceneSpec } from "../components/Scene";

/** Optimistic concurrency: two callers race for one stream version (concurrency-model.md). */
const scene: SceneSpec = {
  title: "Two callers race for one stream",
  participants: [
    { id: "a", label: "caller A", kind: "actor" },
    { id: "b", label: "caller B", kind: "actor" },
    { id: "act", label: "Act", kind: "action" },
    { id: "store", label: "store", kind: "store" },
  ],
  steps: [
    {
      say: "Two callers act on the same stream, `acct-7`, at the same moment.",
      messages: [
        { from: "a", to: "act", label: "app.do(Withdraw)" },
        { from: "b", to: "act", label: "app.do(Withdraw)" },
      ],
    },
    {
      say: "Each action loads the stream. Both see version 5.",
      messages: [
        { from: "act", to: "store", label: "load for A, load for B" },
        { from: "store", to: "act", label: "v5, v5" },
      ],
    },
    {
      say: "Both pass their invariants against v5 and emit their events, each expecting the head to still be 5.",
      notes: [
        { at: "act", text: "A: expectedVersion 5\nB: expectedVersion 5" },
      ],
    },
    {
      say: "Both commit. The store checks the head version and inserts in one transaction.",
      messages: [
        { from: "act", to: "store", label: "commit A, expect 5" },
        { from: "act", to: "store", label: "commit B, expect 5" },
      ],
    },
    {
      say: "A gets there first: the head is 5, so its event lands as v6. B finds the head at 6, not 5.",
      notes: [
        {
          at: "store",
          text: "A: head 5 → insert v6\nB: head 6 ≠ 5",
          tone: "bad",
        },
      ],
    },
    {
      say: "A is done. B gets `ConcurrencyError`, which carries both the expected version and the actual one. (On Postgres, if both read head 5 before either inserts, the unique index rejects the second insert and the adapter throws the same error.)",
      messages: [
        { from: "store", to: "act", label: "A: committed v6", tone: "good" },
        { from: "store", to: "act", label: "B: ConcurrencyError", tone: "bad" },
        { from: "act", to: "a", label: "snapshot v6", tone: "good" },
      ],
    },
    {
      say: "With a retry policy on the action, `.on(action, { maxRetries })`, Act runs B again from `load()` instead of failing it.",
      messages: [
        { from: "act", to: "store", label: "load for B" },
        { from: "store", to: "act", label: "v6" },
      ],
    },
    {
      say: "B decides again on the state A left behind (its invariants may now refuse it) and commits as v7.",
      messages: [
        { from: "act", to: "store", label: "commit B, expect 6" },
        { from: "store", to: "act", label: "committed v7", tone: "good" },
        { from: "act", to: "b", label: "snapshot v7", tone: "good" },
      ],
    },
  ],
};
export default scene;
