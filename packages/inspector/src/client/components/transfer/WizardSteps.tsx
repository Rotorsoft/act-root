import type { ReactNode } from "react";

/**
 * Breadcrumb header for the transfer wizard. Renders the four steps
 * as a horizontal pill row, with the active step highlighted and
 * completed ones rendered as plain text. Steps are not clickable —
 * navigation goes through Back/Next so each step's validation gate
 * fires in order.
 */
export type WizardStep = {
  readonly key: "source" | "target" | "options" | "summary";
  readonly label: string;
};

export const STEPS: ReadonlyArray<WizardStep> = [
  { key: "source", label: "Source" },
  { key: "target", label: "Target" },
  { key: "options", label: "Options" },
  { key: "summary", label: "Summary" },
];

export function WizardHeader({
  active,
}: {
  active: WizardStep["key"];
}): ReactNode {
  const idx = STEPS.findIndex((s) => s.key === active);
  return (
    <ol className="mb-4 flex items-center gap-2 text-[11px]">
      {STEPS.map((step, i) => {
        const state =
          i < idx ? "done" : i === idx ? "active" : "pending";
        return (
          <li key={step.key} className="flex items-center gap-2">
            <span
              className={
                state === "active"
                  ? "rounded-full bg-blue-600 px-2 py-0.5 font-medium text-white"
                  : state === "done"
                    ? "rounded-full border border-emerald-700/40 px-2 py-0.5 text-emerald-400"
                    : "rounded-full border border-zinc-700 px-2 py-0.5 text-zinc-500"
              }
            >
              {i + 1}. {step.label}
            </span>
            {i < STEPS.length - 1 && (
              <span className="text-zinc-700">→</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
