"use client";
import { useState, useEffect, useRef } from "react";
import { blockchainClient } from "blockchain/client";
import { v4 as uuidv4 } from "uuid";

export default function CreatePollPage() {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closeTime, setCloseTime] = useState(() => {
    const now = new Date();
    now.setHours(now.getHours() + 1);
    return now.toISOString().slice(0, 16); // 'YYYY-MM-DDTHH:mm'
  });
  const [loadingSuggestion, setLoadingSuggestion] = useState(false);
  const [hasEdited, setHasEdited] = useState(false);
  const initialLoad = useRef(true);

  // Mark as edited if user changes question or options
  useEffect(() => {
    if (!initialLoad.current) setHasEdited(true);
  }, [question, options]);

  // Fetch poll suggestion on mount or regenerate
  const fetchSuggestion = async () => {
    setLoadingSuggestion(true);
    try {
      const res = await fetch("/api/suggest-poll");
      const data = await res.json();
      if (!hasEdited && data.question && data.options) {
        setQuestion(data.question);
        setOptions(data.options);
      }
    } catch {}
    setLoadingSuggestion(false);
    initialLoad.current = false;
  };

  useEffect(() => {
    fetchSuggestion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOptionChange = (idx: number, value: string) => {
    setOptions((opts) => opts.map((o, i) => (i === idx ? value : o)));
  };

  const addOption = () => setOptions((opts) => [...opts, ""]);
  const removeOption = (idx: number) =>
    setOptions((opts) => opts.filter((_, i) => i !== idx));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSuccess(null);
    setError(null);
    try {
      const now = new Date();
      const closeTimeISO = closeTime
        ? new Date(closeTime).toISOString()
        : new Date(now.getTime() + 60 * 60 * 1000).toISOString();
      const createMarket = blockchainClient.useCreateMarket();
      await createMarket.mutateAsync({
        type: "PollCreated",
        pollId: uuidv4(),
        creator: "dev", // placeholder
        question,
        options: options.filter((o) => o.trim()),
        closeTime: closeTimeISO,
        resolutionCriteria: "TBD", // placeholder
        createdAt: now.toISOString(),
      });
      setSuccess("Poll created!");
      setQuestion("");
      setOptions(["", ""]);
    } catch (err: unknown) {
      setError(
        (err instanceof Error && err.message) || "Failed to create poll"
      );
    }
  };

  // Optionally, add a loading state if you want to track async status
  const [isLoading] = useState(false);

  return (
    <main className="p-8 max-w-xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Create Poll</h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="font-semibold">
          Question
          <input
            className="block w-full mt-1 p-2 border rounded"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            required
            maxLength={200}
          />
        </label>
        <div className="flex items-center gap-2 mb-2">
          <span className="font-semibold">Options</span>
          <button
            type="button"
            className="text-blue-600 text-sm border px-2 py-1 rounded disabled:opacity-50"
            onClick={fetchSuggestion}
            disabled={loadingSuggestion}
          >
            {loadingSuggestion ? "Suggesting..." : "Regenerate"}
          </button>
        </div>
        <div>
          {options.map((opt, idx) => (
            <div key={idx} className="flex gap-2 mt-1">
              <input
                className="flex-1 p-2 border rounded"
                value={opt}
                onChange={(e) => handleOptionChange(idx, e.target.value)}
                required
                maxLength={100}
              />
              {options.length > 2 && (
                <button
                  type="button"
                  onClick={() => removeOption(idx)}
                  className="text-red-500"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={addOption}
            className="mt-2 text-blue-600"
          >
            Add Option
          </button>
        </div>
        <label className="font-semibold mt-2">
          Close Time
          <input
            type="datetime-local"
            className="block w-full mt-1 p-2 border rounded"
            value={closeTime}
            onChange={(e) => setCloseTime(e.target.value)}
            required
          />
        </label>
        <button
          type="submit"
          className="bg-blue-600 text-white px-4 py-2 rounded font-semibold mt-2"
          disabled={isLoading}
        >
          {isLoading ? "Creating..." : "Create Poll"}
        </button>
        {success && <p className="text-green-600">{success}</p>}
        {error && <p className="text-red-600">{error}</p>}
      </form>
    </main>
  );
}
