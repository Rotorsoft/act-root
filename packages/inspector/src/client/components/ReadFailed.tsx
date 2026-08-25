import { AlertTriangle } from "lucide-react";

/**
 * A read that failed, said out loud (#1552 / #1554 / #1566).
 *
 * The panels this replaces used to render a failed read as data — a zeroed
 * dashboard, an empty list, a plausible default — which is the one thing an
 * operator must never be shown while trying to find out what is stuck. This
 * is deliberately unlike an empty state: an amber rule, the server's own
 * message, and a retry.
 */
export function ReadFailed({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex h-48 flex-col items-center justify-center gap-2 px-6 text-center">
      <AlertTriangle size={18} className="text-amber-400" />
      <div className="text-sm text-amber-300">{title}</div>
      {detail && (
        <pre className="max-w-lg whitespace-pre-wrap font-mono text-[10px] text-zinc-500">
          {detail}
        </pre>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
        >
          Try again
        </button>
      )}
    </div>
  );
}
