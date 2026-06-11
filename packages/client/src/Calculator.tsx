import type { Digits, Operators } from "@act/calculator";
import { useState } from "react";
import { callRestAction, type Snapshot } from "./restClient.js";
import { trpc } from "./trpc.js";

type Transport = "trpc" | "rest";

export default function Calculator() {
  const [display, setDisplay] = useState("");
  const [transport, setTransport] = useState<Transport>("trpc");

  // tRPC side — same shape as before, used when transport === "trpc".
  const trpcPressKey = trpc.PressKey.useMutation({
    onSuccess: ([snap]) => applyState(snap),
    onError: console.error,
  });
  const trpcClear = trpc.Clear.useMutation({
    onSuccess: ([snap]) => applyState(snap),
    onError: console.error,
  });

  function applyState(snap: Snapshot) {
    if (snap.state.left === undefined && snap.state.operator === undefined) {
      setDisplay("0");
      return;
    }
    setDisplay(
      `${snap.state.left ?? "0"} ${snap.state.operator ?? ""} ${
        snap.state.right ?? ""
      }`
    );
  }

  const handleKey = (key: string) => {
    if (!key) return;
    if (transport === "trpc") {
      if (key === "C") trpcClear.mutate();
      else trpcPressKey.mutate({ key: key as Digits | Operators });
      return;
    }
    // REST: hit the generated Hono routes mirroring the same actions.
    const action = key === "C" ? "Clear" : "PressKey";
    const body = key === "C" ? {} : { key };
    callRestAction(action, body)
      .then(([snap]) => applyState(snap))
      .catch(console.error);
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
        {[
          "C",
          "",
          "",
          "/",
          "7",
          "8",
          "9",
          "*",
          "4",
          "5",
          "6",
          "-",
          "1",
          "2",
          "3",
          "+",
          "",
          "0",
          ".",
          "=",
        ].map((key, index) => (
          <button key={index} onClick={() => handleKey(key)}>
            {key}
          </button>
        ))}
      </div>
    </div>
  );
}
