import { Activity, Database, GanttChart, GitBranch, List } from "lucide-react";
import type { ReactNode } from "react";

export type Tab = "log" | "timeline" | "streams" | "correlation" | "monitor";

type TabDef = { id: Tab; label: string; icon: ReactNode };

const tabs: TabDef[] = [
  { id: "log", label: "Log", icon: <List size={14} /> },
  { id: "timeline", label: "Timeline", icon: <GanttChart size={14} /> },
  { id: "streams", label: "Streams", icon: <Database size={14} /> },
  { id: "correlation", label: "Correlation", icon: <GitBranch size={14} /> },
  { id: "monitor", label: "Monitor", icon: <Activity size={14} /> },
];

type TabNavProps = {
  active: Tab;
  onChange: (tab: Tab) => void;
  blockedCount?: number;
};

export function TabNav({ active, onChange, blockedCount }: TabNavProps) {
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
          {tab.id === "monitor" && blockedCount != null && blockedCount > 0 && (
            <span className="ml-0.5 rounded-full bg-red-600 px-1.5 py-0.5 text-[9px] font-bold leading-none text-white">
              {blockedCount}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
