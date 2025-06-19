"use client";
import { useParams } from "next/navigation";
import { trpc } from "../../../trpc";
import { useState } from "react";

export default function PollDetailPage() {
  const params = useParams();
  // Next.js App Router always returns params as string or undefined
  const pollId =
    typeof params?.id === "string"
      ? params.id
      : Array.isArray(params?.id)
        ? params.id[0]
        : "";
  const {
    data: poll,
    isLoading: pollLoading,
    error: pollError,
  } = trpc.getPollById.useQuery({ pollId }, { enabled: !!pollId });
  const { data: votes, isLoading: votesLoading } =
    trpc.getVotesForPoll.useQuery({ pollId }, { enabled: !!pollId });
  const castVote = trpc.castVote.useMutation();
  const [selectedOption, setSelectedOption] = useState("");
  const [amount, setAmount] = useState("");
  const [voteMsg, setVoteMsg] = useState<string>("");

  if (!pollId) return <main className="p-8">Invalid poll ID.</main>;

  const pollData = poll && poll[0];
  let options: string[] = [];
  if (pollData && typeof pollData.options === "string") {
    try {
      const parsed = JSON.parse(pollData.options);
      options = Array.isArray(parsed) ? parsed : [];
    } catch {
      options = [];
    }
  }

  const handleVote = async (e: React.FormEvent) => {
    e.preventDefault();
    setVoteMsg("");
    try {
      await castVote.mutateAsync({
        pollId,
        voter: "dev", // placeholder
        option: selectedOption,
        amount,
      });
      setVoteMsg("Vote cast!");
      setAmount("");
      setSelectedOption("");
    } catch (err: any) {
      setVoteMsg(String((err && err.message) ?? "Failed to cast vote"));
    }
  };

  return (
    <main className="p-8 max-w-xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Poll Details</h1>
      {pollLoading && <p>Loading poll...</p>}
      {pollError && <p className="text-red-500">Error: {pollError.message}</p>}
      {pollData && (
        <div className="mb-6">
          <h2 className="text-xl font-semibold mb-2">{pollData.question}</h2>
          <form onSubmit={handleVote} className="flex flex-col gap-2 mb-4">
            <label className="font-semibold">Options:</label>
            <div className="flex flex-col gap-1">
              {options.map((opt) => (
                <label key={opt} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="option"
                    value={opt}
                    checked={selectedOption === opt}
                    onChange={() => setSelectedOption(opt)}
                    required
                  />
                  {opt}
                </label>
              ))}
            </div>
            <label className="font-semibold mt-2">
              Amount
              <input
                className="block w-full mt-1 p-2 border rounded"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </label>
            <button
              type="submit"
              className="bg-blue-600 text-white px-4 py-2 rounded font-semibold mt-2"
              disabled={castVote.status === "pending"}
            >
              {castVote.status === "pending" ? "Voting..." : "Cast Vote"}
            </button>
            {voteMsg && <p className="mt-2 text-green-600">{voteMsg}</p>}
          </form>
        </div>
      )}
      <h3 className="text-lg font-semibold mb-2">Votes</h3>
      {votesLoading && <p>Loading votes...</p>}
      {votes && votes.length === 0 && <p>No votes yet.</p>}
      {votes && votes.length > 0 && (
        <table className="w-full border mt-2">
          <thead>
            <tr className="bg-zinc-100 dark:bg-zinc-800">
              <th className="p-2 text-left">Voter</th>
              <th className="p-2 text-left">Option</th>
              <th className="p-2 text-left">Amount</th>
              <th className="p-2 text-left">Cast At</th>
            </tr>
          </thead>
          <tbody>
            {votes.map((v) => (
              <tr key={v.txHash} className="border-t">
                <td className="p-2 font-mono">{v.voter}</td>
                <td className="p-2">{v.option}</td>
                <td className="p-2">{v.amount}</td>
                <td className="p-2 font-mono text-xs">{v.castAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
