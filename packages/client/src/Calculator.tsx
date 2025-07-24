import type { Digits, Operators } from "@act/calculator";
import { useState } from "react";
import { trpc } from "./trpc.js";

export default function Calculator() {
  const [display, setDisplay] = useState("");

  const pressKey = trpc.PressKey.useMutation({
    onSuccess: ([snap]) => {
      console.log(snap.state);
      setDisplay(
        `${snap.state.left ?? "0"} ${snap.state.operator ?? ""} ${
          snap.state.right ?? ""
        }`
      );
    },
    onError: console.error,
  });

  const clear = trpc.Clear.useMutation({
    onSuccess: ([snap]) => {
      console.log(snap.state);
      setDisplay("0");
    },
    onError: console.error,
  });

  const handleKey = (key: string) => {
    if (!key) return;
    if (key === "C") clear.mutate();
    else pressKey.mutate({ key: key as Digits | Operators });
  };

  return (
    <div className="calculator">
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
