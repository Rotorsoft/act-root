import { Database, GanttChart, List } from "lucide-react";
import type { ReactNode } from "react";

export type Tab = "log" | "timeline" | "streams";

type TabDef = { id: Tab; label: string; icon: ReactNode };

const tabs: TabDef[] = [
  { id: "log", label: "Log", icon: <List size={14} /> },
  { id: "timeline", label: "Timeline", icon: <GanttChart size={14} /> },
  { id: "streams", label: "Streams", icon: <Database size={14} /> },
];

type TabNavProps = {
  active: Tab;
  onChange: (tab: Tab) => void;
};

export function TabNav({ active, onChange }: TabNavProps) {
  return (
    <div className="flex border-b border-zinc-800 bg-zinc-925">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition ${
            active === tab.id
              ? "border-b-2 border-emerald-500 text-emerald-400"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  );
}
