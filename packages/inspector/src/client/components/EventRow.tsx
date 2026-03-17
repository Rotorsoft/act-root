import { useState } from "react";
import { JsonViewer } from "./JsonViewer.js";

type EventMeta = {
  correlation?: string;
  causation?: {
    action?: {
      stream?: string;
      actor?: { id?: string; name?: string };
      name?: string;
    };
    event?: { id?: number; name?: string; stream?: string };
  };
};

type Event = {
  id: number;
  name: string;
  stream: string;
  version: number;
  created: string;
  data: unknown;
  meta: EventMeta;
};

type EventRowProps = {
  event: Event;
  defaultExpanded?: boolean;
  compact?: boolean;
  hideStream?: boolean;
  onTrace?: (correlationId: string) => void;
  onStream?: (stream: string) => void;
};

/** Deterministic color from event name */
function nameColor(name: string): string {
  const colors = [
    "bg-sky-900/50 text-sky-300 border-sky-800",
    "bg-amber-900/50 text-amber-300 border-amber-800",
    "bg-emerald-900/50 text-emerald-300 border-emerald-800",
    "bg-purple-900/50 text-purple-300 border-purple-800",
    "bg-rose-900/50 text-rose-300 border-rose-800",
    "bg-cyan-900/50 text-cyan-300 border-cyan-800",
    "bg-orange-900/50 text-orange-300 border-orange-800",
    "bg-indigo-900/50 text-indigo-300 border-indigo-800",
    "bg-teal-900/50 text-teal-300 border-teal-800",
    "bg-pink-900/50 text-pink-300 border-pink-800",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return colors[Math.abs(hash) % colors.length];
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1000) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function copyToClipboard(text: string) {
  void navigator.clipboard.writeText(text);
}

/** Clickable link styled text */
function Link({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      className="text-emerald-400/80 underline decoration-emerald-400/30 underline-offset-2 transition hover:text-emerald-300 hover:decoration-emerald-300/50"
    >
      {children}
    </button>
  );
}

export function EventRow({
  event,
  defaultExpanded = false,
  compact = false,
  hideStream = false,
  onTrace,
  onStream,
}: EventRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const actor = event.meta?.causation?.action?.actor;

  return (
    <div className="border-b border-zinc-800/50 transition hover:bg-zinc-900/50">
      {/* Main row */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-4 py-2 text-left text-xs"
      >
        {/* ID */}
        <span className="w-16 shrink-0 font-mono text-zinc-500">
          #{event.id}
        </span>

        {/* Actor */}
        <span className="w-24 shrink-0 truncate text-zinc-500">
          {actor?.name ?? ""}
        </span>

        {/* Version */}
        <span className="w-12 shrink-0 text-right font-mono text-zinc-500">
          v{event.version}
        </span>

        {/* Event name pill */}
        <span className="w-36 shrink-0 truncate">
          <span
            className={`inline-block rounded-md border px-2 py-0.5 text-[11px] font-medium ${nameColor(event.name)}`}
          >
            {event.name}
          </span>
        </span>

        {/* Stream — clickable link */}
        {!hideStream && (
          <span className="min-w-0 flex-1 truncate font-mono text-zinc-300">
            {onStream ? (
              <Link
                title="Open in Streams"
                onClick={() => onStream(event.stream)}
              >
                {event.stream}
              </Link>
            ) : (
              event.stream
            )}
          </span>
        )}

        {/* Time */}
        <span
          className="w-20 shrink-0 text-right text-zinc-500"
          title={new Date(event.created).toLocaleString()}
        >
          {relativeTime(event.created)}
        </span>

        {/* Expand indicator */}
        <span className="w-4 shrink-0 text-zinc-600">
          {expanded ? "▾" : "▸"}
        </span>
      </button>

      {/* Expanded detail — compact */}
      {expanded && compact && (
        <div className="border-t border-zinc-800/30 bg-zinc-900/60 px-4 py-1.5 text-xs">
          <JsonViewer data={event.data} />
        </div>
      )}

      {/* Expanded detail — full */}
      {expanded && !compact && (
        <div className="border-t border-zinc-800/30 bg-zinc-900/80 px-4 py-3">
          <div className="grid grid-cols-2 gap-4">
            {/* Data */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                  Data
                </span>
                <button
                  onClick={() =>
                    copyToClipboard(JSON.stringify(event.data, null, 2))
                  }
                  className="text-[10px] text-zinc-600 transition hover:text-zinc-400"
                >
                  Copy
                </button>
              </div>
              <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs">
                <JsonViewer data={event.data} />
              </div>
            </div>

            {/* Meta */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                  Meta
                </span>
                <button
                  onClick={() =>
                    copyToClipboard(JSON.stringify(event.meta, null, 2))
                  }
                  className="text-[10px] text-zinc-600 transition hover:text-zinc-400"
                >
                  Copy
                </button>
              </div>
              <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs">
                <JsonViewer data={event.meta} />
              </div>
            </div>
          </div>

          {/* Quick info bar */}
          <div className="mt-3 flex flex-wrap gap-4 text-[10px] text-zinc-500">
            <span>
              Stream:{" "}
              {onStream ? (
                <Link
                  title="Open in Streams"
                  onClick={() => onStream(event.stream)}
                >
                  {event.stream}
                </Link>
              ) : (
                <button
                  onClick={() => copyToClipboard(event.stream)}
                  className="text-zinc-300 hover:text-emerald-400"
                >
                  {event.stream}
                </button>
              )}
            </span>
            {event.meta?.correlation && (
              <span>
                Correlation:{" "}
                {onTrace ? (
                  <Link
                    title="Trace correlation chain"
                    onClick={() => onTrace(event.meta.correlation!)}
                  >
                    {event.meta.correlation}
                  </Link>
                ) : (
                  <button
                    onClick={() => copyToClipboard(event.meta.correlation!)}
                    className="font-mono text-zinc-300 hover:text-emerald-400"
                  >
                    {event.meta.correlation}
                  </button>
                )}
              </span>
            )}
            <span>
              Created:{" "}
              <span className="text-zinc-300">
                {new Date(event.created).toISOString()}
              </span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
