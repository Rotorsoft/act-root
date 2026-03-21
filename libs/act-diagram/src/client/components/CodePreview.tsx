import { X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

const HIGHLIGHT_COLORS: Record<string, { border: string; bg: string }> = {
  action: { border: "#3b82f6", bg: "rgba(30,64,175,0.2)" },
  event: { border: "#f97316", bg: "rgba(194,65,12,0.2)" },
  state: { border: "#eab308", bg: "rgba(161,98,7,0.2)" },
  reaction: { border: "#a855f7", bg: "rgba(126,34,206,0.2)" },
  projection: { border: "#22c55e", bg: "rgba(21,128,61,0.2)" },
};
const DEFAULT_HIGHLIGHT = { border: "#fbbf24", bg: "rgba(245,158,11,0.15)" };

type Props = {
  filePath: string;
  content: string;
  targetLine: number; // 1-based
  elementType?: string;
  onClose: () => void;
};

export function CodePreview({
  filePath,
  content,
  targetLine,
  elementType,
  onClose,
}: Props) {
  const highlightRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll highlighted line into view
  useEffect(() => {
    const el = highlightRef.current;
    if (el) {
      // Delay one frame so the panel has been laid out
      requestAnimationFrame(() =>
        el.scrollIntoView({ block: "center", behavior: "smooth" })
      );
    }
  }, [targetLine, filePath]);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const lines = content.split("\n");
  const gutterWidth = String(lines.length).length;
  const colors = useMemo(
    () => (elementType && HIGHLIGHT_COLORS[elementType]) || DEFAULT_HIGHLIGHT,
    [elementType]
  );

  return (
    <div className="flex h-full flex-col border-l border-zinc-800 bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1">
        <span className="truncate font-mono text-[10px] text-zinc-400">
          {filePath}
          <span className="ml-2 text-zinc-600">:{targetLine}</span>
        </span>
        <button
          onClick={onClose}
          className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          title="Close (Esc)"
        >
          <X size={12} />
        </button>
      </div>

      {/* Code area */}
      <div ref={scrollRef} className="flex-1 overflow-auto">
        <pre className="text-[11px] leading-[1.6]">
          {lines.map((line, i) => {
            const lineNum = i + 1;
            const isTarget = lineNum === targetLine;
            return (
              <div
                key={i}
                ref={isTarget ? highlightRef : undefined}
                style={
                  isTarget
                    ? {
                        borderLeft: `2px solid ${colors.border}`,
                        background: colors.bg,
                      }
                    : { borderLeft: "2px solid transparent" }
                }
              >
                <span
                  className="inline-block select-none pr-3 text-right text-zinc-600"
                  style={{ width: `${gutterWidth + 2}ch` }}
                >
                  {lineNum}
                </span>
                <span className="text-zinc-300">{line}</span>
              </div>
            );
          })}
        </pre>
      </div>
    </div>
  );
}
