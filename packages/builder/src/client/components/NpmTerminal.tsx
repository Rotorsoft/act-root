import {
  AlertTriangle,
  ChevronRight,
  Loader2,
  Terminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { skippedDevDeps } from "../lib/workspace-fs.js";

type Props = {
  show: boolean;
  onClose: () => void;
  projectKey: string;
};

type PkgStatus = "downloading" | "downloaded";
type PkgEntry = {
  kind: "pkg";
  pkg: string;
  version?: string;
  status: PkgStatus;
  downloadStartedAt?: number;
  elapsedMs?: number;
};
type MsgEntry = { kind: "msg"; status: "info" | "warning"; text: string };
type LogEntry = PkgEntry | MsgEntry;

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function NpmTerminal({ show, onClose, projectKey }: Props) {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [active, setActive] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const startTimeRef = useRef<number>(0);

  // ── Batched log updates to avoid per-message re-renders ────────────
  const pendingRef = useRef<
    {
      type: "start" | "done";
      pkg: string;
      version?: string;
      time: number;
      elapsedMs?: number;
    }[]
  >([]);
  const rafRef = useRef(0);

  const flushPending = useCallback(() => {
    rafRef.current = 0;
    const batch = pendingRef.current.splice(0);
    if (batch.length === 0) return;

    setActive(true);
    if (!startTimeRef.current) startTimeRef.current = batch[0].time;

    setLog((prev) => {
      const next = [...prev];
      for (const msg of batch) {
        const idx = next.findIndex(
          (e) => e.kind === "pkg" && e.pkg === msg.pkg
        );
        if (msg.type === "start") {
          if (idx < 0) {
            next.push({
              kind: "pkg",
              pkg: msg.pkg,
              status: "downloading",
              downloadStartedAt: msg.time,
            });
          }
        } else {
          // done
          if (idx >= 0) {
            const entry = next[idx] as PkgEntry;
            next[idx] = {
              ...entry,
              status: "downloaded",
              version: msg.version,
              elapsedMs:
                msg.elapsedMs ??
                (entry.downloadStartedAt
                  ? msg.time - entry.downloadStartedAt
                  : undefined),
            };
          } else {
            next.push({
              kind: "pkg",
              pkg: msg.pkg,
              status: "downloaded",
              version: msg.version,
              elapsedMs: msg.elapsedMs,
            });
          }
        }
      }
      return next;
    });
  }, []);

  // Clear log when project changes
  useEffect(() => {
    setLog([]);
    setActive(false);
    startTimeRef.current = 0;
    pendingRef.current = [];
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  }, [projectKey]);

  // Subscribe to custom events from fetchNpmTypes (no SW dependency)
  useEffect(() => {
    const handler = (event: Event) => {
      const { type, pkg, version, elapsedMs } = (event as CustomEvent)
        .detail as {
        type: "start" | "done";
        pkg: string;
        version?: string;
        elapsedMs?: number;
      };

      pendingRef.current.push({
        type,
        pkg,
        version,
        time: type === "start" ? Date.now() : Date.now(),
        ...(type === "done" && elapsedMs != null ? { elapsedMs } : {}),
      });

      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(flushPending);
      }
    };
    window.addEventListener("npm-type-fetch", handler);
    return () => {
      window.removeEventListener("npm-type-fetch", handler);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [flushPending]);

  // Mark complete after inactivity
  useEffect(() => {
    if (log.length === 0) return;
    const timer = setTimeout(() => {
      if (active) {
        setActive(false);
        const totalMs = startTimeRef.current
          ? Date.now() - startTimeRef.current
          : 0;
        startTimeRef.current = 0;
        setLog((prev) => [
          ...prev.map(
            (e): LogEntry =>
              e.kind === "pkg" && e.status === "downloading"
                ? { ...e, status: "downloaded" as const }
                : e
          ),
          {
            kind: "msg",
            status: "info",
            text: `Type acquisition complete in ${formatMs(totalMs)}`,
          } as MsgEntry,
        ]);
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [log.length, active]);

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [log]);

  const pkgCount = log.filter((l) => l.kind === "pkg").length;

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50">
      <div className="flex w-full max-w-xl flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950 shadow-2xl">
        {/* Title bar */}
        <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
          <Terminal size={14} className="text-cyan-400" />
          <span className="text-xs font-medium text-zinc-300">
            Type Acquisition
          </span>
          {active && (
            <Loader2 size={12} className="animate-spin text-cyan-400" />
          )}
          <span className="ml-auto text-[10px] text-zinc-600">
            {pkgCount} packages
          </span>
          <button
            onClick={onClose}
            className="rounded p-0.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
          >
            <X size={14} />
          </button>
        </div>

        {/* Warnings */}
        <div className="border-b border-zinc-800 bg-zinc-900/50 px-3 py-2 text-[10px]">
          <div className="flex items-start gap-1.5 text-amber-500">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
            <div>
              <div>
                devDependencies excluded from type resolution for performance
              </div>
              <div className="text-zinc-600">
                Private/workspace packages resolved from local sources
              </div>
            </div>
          </div>
          {skippedDevDeps.length > 0 && (
            <div className="mt-1.5 pl-4">
              <button
                onClick={() => setShowSkipped((v) => !v)}
                className="flex items-center gap-1 text-zinc-500 transition hover:text-zinc-300"
              >
                <ChevronRight
                  size={10}
                  className={`transition-transform ${showSkipped ? "rotate-90" : ""}`}
                />
                {skippedDevDeps.length} devDependencies excluded
              </button>
              {showSkipped && (
                <div className="mt-1 max-h-24 overflow-auto pl-3 text-zinc-600">
                  {skippedDevDeps.map((name) => (
                    <div key={name}>{name}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Terminal log */}
        <div
          ref={scrollRef}
          className="h-64 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed"
        >
          {log.map((entry, i) => {
            if (entry.kind === "pkg") {
              const done = entry.status === "downloaded";
              return (
                <div
                  key={entry.pkg}
                  className={done ? "text-emerald-400" : "text-zinc-400"}
                >
                  <span className="text-zinc-700 select-none">
                    {done ? "  \u2713 " : "  \u25B8 "}
                  </span>
                  {entry.pkg}
                  {entry.version && (
                    <span className="text-zinc-600">@{entry.version}</span>
                  )}
                  <span className="ml-2 text-zinc-700">
                    {done
                      ? entry.elapsedMs
                        ? formatMs(entry.elapsedMs)
                        : "cached"
                      : "downloading\u2026"}
                  </span>
                </div>
              );
            }
            return (
              <div
                key={i}
                className={
                  entry.status === "warning"
                    ? "text-amber-500"
                    : "text-cyan-400"
                }
              >
                <span className="text-zinc-700 select-none">
                  {entry.status === "warning" ? "  \u26A0 " : "  \u2714 "}
                </span>
                {entry.text}
              </div>
            );
          })}
          {active && (
            <div className="text-zinc-600">
              <span className="inline-block animate-pulse">{"\u2588"}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
