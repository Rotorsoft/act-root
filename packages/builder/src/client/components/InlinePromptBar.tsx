import { Loader2, Send, Sparkles } from "lucide-react";

export type InlinePromptBarProps = {
  promptInput: string;
  onPromptInputChange: (value: string) => void;
  onGenerate: () => void;
  onClose: () => void;
  generating: boolean;
  effectiveModel: string;
  onModelChange: (model: string) => void;
  models: { id: string; label: string }[];
};

export function InlinePromptBar({
  promptInput,
  onPromptInputChange,
  onGenerate,
  onClose,
  generating,
  effectiveModel,
  onModelChange,
  models,
}: InlinePromptBarProps) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-925 px-4 py-1.5">
      <Sparkles
        size={13}
        className="mt-1 shrink-0 self-start text-purple-400"
      />
      <textarea
        value={promptInput}
        onChange={(e) => onPromptInputChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onGenerate();
          }
          if (e.key === "Escape") onClose();
        }}
        placeholder="Refine the code... (Enter to send, Esc to close)"
        rows={Math.min(5, Math.max(1, promptInput.split("\n").length))}
        className="flex-1 resize-y rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-purple-600"
        autoFocus
      />
      <select
        value={effectiveModel}
        onChange={(e) => onModelChange(e.target.value)}
        className="rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-[9px] text-zinc-400 outline-none"
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      <button
        onClick={onGenerate}
        disabled={generating || !promptInput.trim()}
        className="flex items-center gap-1 rounded-md bg-purple-600 px-3 py-1 text-[10px] font-medium text-white transition hover:bg-purple-500 disabled:opacity-50"
      >
        {generating ? (
          <Loader2 size={11} className="animate-spin" />
        ) : (
          <Send size={11} />
        )}
        Refine
      </button>
    </div>
  );
}
