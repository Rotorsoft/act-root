import { Loader2, Send, Sparkles } from "lucide-react";
import { useState } from "react";

type Props = {
  onSubmit: (prompt: string) => void;
  generating?: boolean;
};

export function AiBar({ onSubmit, generating }: Props) {
  const [prompt, setPrompt] = useState("");

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-925 px-4 py-1.5">
      <Sparkles size={13} className="shrink-0 text-purple-400" />
      <input
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && prompt.trim()) {
            onSubmit(prompt);
            setPrompt("");
          }
        }}
        placeholder="Refine with AI..."
        className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-purple-600"
        disabled={generating}
      />
      <button
        onClick={() => {
          if (prompt.trim()) {
            onSubmit(prompt);
            setPrompt("");
          }
        }}
        disabled={generating || !prompt.trim()}
        className="flex items-center gap-1 rounded-md bg-purple-600 px-3 py-1 text-[10px] font-medium text-white transition hover:bg-purple-500 disabled:opacity-50"
      >
        {generating ? (
          <Loader2 size={11} className="animate-spin" />
        ) : (
          <Send size={11} />
        )}
      </button>
    </div>
  );
}
