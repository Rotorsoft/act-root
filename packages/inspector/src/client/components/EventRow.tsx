import { Database, GitBranch } from "lucide-react";
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

/** Framework internal event names */
const FRAMEWORK_EVENTS: Record<string, string> = {
  __tombstone__: "bg-red-900/60 text-red-300 border-red-700",
  __snapshot__: "bg-zinc-800/60 text-zinc-400 border-zinc-700",
};

/** Deterministic color from event name */
function nameColor(name: string): string {
  if (FRAMEWORK_EVENTS[name]) return FRAMEWORK_EVENTS[name];
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

const eventDateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "short",
});
const eventTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeStyle: "medium",
});

function copyToClipboard(text: string) {
  void navigator.clipboard.writeText(text);
}

/** Inline clickable link — small, subtle */
function NavLink({
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
      className="text-emerald-400/70 transition hover:text-emerald-300"
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
  const causation = event.meta?.causation;
  const actor = causation?.action?.actor;
  const correlation = event.meta?.correlation;
  // Reactions to upstream events show the source event's name + id
  // (+ stream when present); root-cause actions show the action name
  // (+ target stream). The full causation object stays in the tooltip
  // so operators can still see actor details / extra fields without
  // expanding the row. Actor lives in its own column, so it's omitted
  // here to avoid the duplicate.
  const causedByEvent = causation?.event;
  const causedByAction = causation?.action;
  // Split into two visual segments so the action/event name pops in
  // blue while the destination stream stays muted — same row reads as
  // "what" (highlighted) "where" (muted).
  const causationParts: { name: string; suffix: string } = (() => {
    if (causedByEvent?.name) {
      const id = causedByEvent.id != null ? ` #${causedByEvent.id}` : "";
      return {
        name: `${causedByEvent.name}${id}`,
        suffix: causedByEvent.stream ? ` → ${causedByEvent.stream}` : "",
      };
    }
    if (causedByAction?.name) {
      return {
        name: causedByAction.name,
        suffix: causedByAction.stream ? ` → ${causedByAction.stream}` : "",
      };
    }
    return { name: "", suffix: "" };
  })();
  const causationTitle = causation
    ? JSON.stringify(causation, null, 2)
    : "";

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

        {/* Version */}
        <span className="w-12 shrink-0 text-right font-mono text-zinc-500">
          {event.version}
        </span>

        {/* Stream */}
        {!hideStream && (
          <span
            className="w-64 shrink-0 truncate font-mono text-zinc-300"
            title={event.stream}
          >
            {event.stream}
            {onStream && (
              <>
                {" "}
                <NavLink
                  title="Open in Streams"
                  onClick={() => onStream(event.stream)}
                >
                  <Database size={10} className="inline" />
                </NavLink>
              </>
            )}
          </span>
        )}

        {/* Event name pill */}
        <span className="w-36 shrink-0 truncate">
          <span
            className={`inline-block rounded-md border px-2 py-0.5 text-[11px] font-medium ${nameColor(event.name)}`}
          >
            {event.name}
          </span>
        </span>

        {/* Date + time (split colors so the time-of-day pops against
            the muted date; no comma between them — the color shift is
            the separator). */}
        <span
          className="w-36 shrink-0 truncate text-right font-mono"
          title={new Date(event.created).toISOString()}
        >
          <span className="text-violet-300">
            {eventDateFormatter.format(new Date(event.created))}
          </span>{" "}
          <span className="text-emerald-300">
            {eventTimeFormatter.format(new Date(event.created))}
          </span>
        </span>

        {/* Correlation */}
        {correlation && (
          <span
            className="w-80 shrink-0 truncate font-mono text-zinc-500"
            title={correlation}
          >
            {correlation}
            {onTrace && (
              <>
                {" "}
                <NavLink
                  title="Trace correlation"
                  onClick={() => onTrace(correlation)}
                >
                  <GitBranch size={10} className="inline" />
                </NavLink>
              </>
            )}
          </span>
        )}
        {!correlation && <span className="w-80 shrink-0" />}

        {/* Actor */}
        <span className="w-24 shrink-0 truncate text-amber-300">
          {actor?.name ?? ""}
        </span>

        {/* Causation — action/event name in blue, `→ stream` muted */}
        <span
          className="w-64 shrink-0 truncate font-mono"
          title={causationTitle}
        >
          <span className="text-sky-300">{causationParts.name}</span>
          <span className="text-zinc-500">{causationParts.suffix}</span>
        </span>

        <span className="min-w-0 flex-1" />

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
        </div>
      )}
    </div>
  );
}
