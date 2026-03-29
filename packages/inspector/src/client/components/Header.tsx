import { ChevronDown, ChevronLeft, ChevronRight, Radio } from "lucide-react";
import { useState } from "react";
import { viewCaption, type ViewState } from "../App.js";
import { BackupRestore } from "./BackupRestore.js";
import { Logo } from "./Logo.js";

const POLL_OPTIONS = [
  { label: "Off", ms: 0 },
  { label: "5s", ms: 5_000 },
  { label: "10s", ms: 10_000 },
  { label: "30s", ms: 30_000 },
];

type HeaderProps = {
  connected: boolean;
  connectionName: string;
  onConnect: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  history?: ViewState[];
  historyIndex?: number;
  onGoTo?: (index: number) => void;
  pollInterval?: number;
  onPollChange?: (ms: number) => void;
};

export function Header({
  connected,
  connectionName,
  onConnect,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  history,
  historyIndex,
  onGoTo,
  pollInterval = 0,
  onPollChange,
}: HeaderProps) {
  const [showHistory, setShowHistory] = useState(false);
  const hasHistory = history && history.length > 1;
  const isLive = pollInterval > 0;

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-925 px-4">
      <div className="flex items-center gap-2.5">
        <Logo size={22} />
        <h1 className="text-sm font-semibold tracking-wide text-zinc-300">
          <span className="text-emerald-400">act</span> inspector
        </h1>

        {/* Navigation */}
        {connected && (
          <div className="relative ml-2 flex items-center gap-0.5">
            <button
              onClick={onBack}
              disabled={!canGoBack}
              title="Back"
              className="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-zinc-500"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={onForward}
              disabled={!canGoForward}
              title="Forward"
              className="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-zinc-500"
            >
              <ChevronRight size={16} />
            </button>

            {/* History dropdown toggle */}
            {hasHistory && (
              <button
                onClick={() => setShowHistory(!showHistory)}
                title="Navigation history"
                className="rounded p-1 text-zinc-600 transition hover:bg-zinc-800 hover:text-zinc-400"
              >
                <ChevronDown size={12} />
              </button>
            )}

            {/* History dropdown */}
            {showHistory && history && onGoTo && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setShowHistory(false)}
                />
                <div className="absolute left-0 top-full z-50 mt-1 max-h-64 w-64 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl">
                  {history.map((entry, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        onGoTo(i);
                        setShowHistory(false);
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition ${
                        i === historyIndex
                          ? "bg-zinc-800 text-emerald-400"
                          : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                      }`}
                    >
                      {i < (historyIndex ?? 0) && (
                        <span className="w-3 shrink-0 text-[9px] text-zinc-600">
                          ←
                        </span>
                      )}
                      {i === historyIndex && (
                        <span className="w-3 shrink-0 text-[9px] text-emerald-500">
                          ●
                        </span>
                      )}
                      {i > (historyIndex ?? 0) && (
                        <span className="w-3 shrink-0 text-[9px] text-zinc-600">
                          →
                        </span>
                      )}
                      <span className="truncate">{viewCaption(entry)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-3">
        {/* Live polling */}
        {connected && onPollChange && (
          <div className="flex items-center gap-1.5">
            <Radio
              size={12}
              className={
                isLive ? "animate-pulse text-emerald-400" : "text-zinc-600"
              }
            />
            {POLL_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                onClick={() => onPollChange(opt.ms)}
                className={`rounded px-1.5 py-0.5 text-[10px] transition ${
                  pollInterval === opt.ms
                    ? isLive
                      ? "bg-emerald-950 text-emerald-400"
                      : "bg-zinc-800 text-zinc-300"
                    : "text-zinc-600 hover:text-zinc-400"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}

        {/* Backup/Restore */}
        {connected && <BackupRestore />}

        {connected ? (
          <button
            onClick={onConnect}
            className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-750"
          >
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            {connectionName}
          </button>
        ) : (
          <button
            onClick={onConnect}
            className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-400 transition hover:border-zinc-600"
          >
            <span className="h-2 w-2 rounded-full bg-zinc-600" />
            Not connected
          </button>
        )}
      </div>
    </header>
  );
}
