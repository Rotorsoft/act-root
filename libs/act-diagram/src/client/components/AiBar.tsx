import { Loader2, Send, Sparkles } from "lucide-react";
import { useState } from "react";

const MODELS = [
  { id: "claude-sonnet-4-6", label: "Sonnet" },
  { id: "claude-opus-4-6", label: "Opus" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku" },
];

const TOKEN_OPTIONS = [
  { value: 4096, label: "4k" },
  { value: 8192, label: "8k" },
  { value: 16384, label: "16k" },
  { value: 32768, label: "32k" },
];

export type AiOptions = {
  model: string;
  maxTokens: number;
};

type Props = {
  onSubmit: (prompt: string, options: AiOptions) => void;
  generating?: boolean;
};

export function AiBar({ onSubmit, generating }: Props) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(MODELS[0].id);
  const [maxTokens, setMaxTokens] = useState(16384);

  const submit = () => {
    if (prompt.trim()) {
      onSubmit(prompt, { model, maxTokens });
      setPrompt("");
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-925 px-4 py-1.5">
      <Sparkles size={13} className="shrink-0 text-purple-400" />
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Refine with AI... (Shift+Enter for new line)"
        rows={1}
        className="flex-1 resize-y rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-purple-600"
        style={{ minHeight: "28px", maxHeight: "200px" }}
        disabled={generating}
      />
      <select
        value={model}
        onChange={(e) => setModel(e.target.value)}
        disabled={generating}
        className="rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-[10px] text-zinc-400 outline-none focus:border-purple-600"
      >
        {MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      <select
        value={maxTokens}
        onChange={(e) => setMaxTokens(Number(e.target.value))}
        disabled={generating}
        className="rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-[10px] text-zinc-400 outline-none focus:border-purple-600"
      >
        {TOKEN_OPTIONS.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
      <button
        onClick={submit}
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
