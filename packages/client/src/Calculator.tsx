import type { LiveState } from "@act/server";
import type { Keys } from "@act/calculator";
import { applyPatchMessage } from "@rotorsoft/act-http/sse";
import { useRef, useState } from "react";
import { rest } from "./restClient.js";
import { trpc } from "./trpc.js";

type Transport = "trpc" | "rest";
type Key = Keys | "C" | "";

const BUTTONS: readonly Key[] = [
  "C", "", "", "/",
  "7", "8", "9", "*",
  "4", "5", "6", "-",
  "1", "2", "3", "+",
  "", "0", ".", "=",
];

/** What the display shows, from a snapshot's state or the live state. */
type Display = Pick<LiveState, "left" | "operator" | "right">;

function format(s: Display): string {
  if (s.left === undefined && s.operator === undefined) return "0";
  return `${s.left ?? "0"} ${s.operator ?? ""} ${s.right ?? ""}`;
}

export default function Calculator() {
  const [display, setDisplay] = useState("");
  const [transport, setTransport] = useState<Transport>("trpc");
  const [live, setLive] = useState<LiveState>();
  const cached = useRef<LiveState | undefined>(undefined);

  // Live state from the generated `subscribe.Calculator`: the cached state
  // on open, then a patch per commit (from either transport, or another
  // tab). A patch that finds versions missing resubscribes for a fresh state.
  const subscription = trpc.subscribe.Calculator.useSubscription(
    { stream: "calculator" },
    {
      onData: (frame) => {
        if (frame.kind === "state") cached.current = frame.data;
        else {
          const result = applyPatchMessage(frame.data, cached.current);
          // "stale": already ahead (a mutation's response can land first).
          if (!result.ok) {
            if (result.reason === "behind") subscription.reset();
            return;
          }
          cached.current = result.state;
        }
        setLive(cached.current);
      },
    }
  );

  const show = ([snap]: { state: Display }[]) =>
    setDisplay(format(snap.state));
  const trpcPressKey = trpc.PressKey.useMutation({
    onSuccess: show,
    onError: console.error,
  });
  const trpcClear = trpc.Clear.useMutation({
    onSuccess: show,
    onError: console.error,
  });

  const handleKey = async (key: Key) => {
    if (!key) return;
    if (transport === "trpc") {
      if (key === "C") trpcClear.mutate({});
      else trpcPressKey.mutate({ key });
      return;
    }
    // REST: the generated Hono routes for the same actions.
    const res = await (key === "C"
      ? rest.api.actions.Clear.$post({ json: {} })
      : rest.api.actions.PressKey.$post({ json: { key } }));
    if (res.ok) show(await res.json());
    else console.error((await res.json()).detail);
  };

  return (
    <div className="calculator">
      <div className="transport-bar">
        <label>
          <input
            type="radio"
            name="transport"
            value="trpc"
            checked={transport === "trpc"}
            onChange={() => setTransport("trpc")}
          />
          tRPC
        </label>
        <label>
          <input
            type="radio"
            name="transport"
            value="rest"
            checked={transport === "rest"}
            onChange={() => setTransport("rest")}
          />
          REST
        </label>
        <a
          href="http://localhost:4000/docs"
          target="_blank"
          rel="noreferrer"
          className="openapi-link"
        >
          API docs
        </a>
      </div>
      <div className="display">{display || "0"}</div>
      <div className="buttons">
        {BUTTONS.map((key, index) => (
          <button key={index} onClick={() => handleKey(key)}>
            {key}
          </button>
        ))}
      </div>
      <div className="sse-panel">
        <div className="sse-label">
          SSE live {live ? `(v${live._v})` : "— waiting for first commit"}
        </div>
        <div className="display sse-display">
          {live ? format(live) : "–"}
        </div>
      </div>
    </div>
  );
}
