"use client";
import { useState } from "react";
import { trpc } from "../../../trpc";

export default function CreatePollPage() {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const createPoll = trpc.createPoll.useMutation();

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
      await createPoll.mutateAsync({
        question,
        options: options.filter((o) => o.trim()),
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

  const isLoading = createPoll.status === "pending";

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
        <div>
          <span className="font-semibold">Options</span>
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
