export type Tab = "log" | "timeline" | "streams";

type TabNavProps = {
  active: Tab;
  onChange: (tab: Tab) => void;
};

const tabs: { id: Tab; label: string }[] = [
  { id: "log", label: "Log" },
  { id: "timeline", label: "Timeline" },
  { id: "streams", label: "Streams" },
];

export function TabNav({ active, onChange }: TabNavProps) {
  return (
    <div className="flex border-b border-zinc-800 bg-zinc-925">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`px-4 py-2 text-xs font-medium transition ${
            active === tab.id
              ? "border-b-2 border-emerald-500 text-emerald-400"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
