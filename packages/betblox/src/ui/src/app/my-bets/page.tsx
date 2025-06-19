"use client";
import { trpc } from "../../trpc";

export default function MyBetsPage() {
  // For demo, use a hardcoded voter
  const { data, isLoading, error } = trpc.getWinningsForUser.useQuery({
    voter: "dev",
  });

  return (
    <main className="p-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">My Bets</h1>
      {isLoading && <p>Loading...</p>}
      {error && <p className="text-red-500">Error: {error.message}</p>}
      {data && data.length === 0 && <p>No winnings found.</p>}
      {data && data.length > 0 && (
        <table className="w-full border mt-4">
          <thead>
            <tr className="bg-zinc-100 dark:bg-zinc-800">
              <th className="p-2 text-left">Poll ID</th>
              <th className="p-2 text-left">Amount</th>
              <th className="p-2 text-left">Claimed At</th>
              <th className="p-2 text-left">Tx Hash</th>
            </tr>
          </thead>
          <tbody>
            {data.map((w) => (
              <tr key={w.txHash} className="border-t">
                <td className="p-2 font-mono">{w.pollId}</td>
                <td className="p-2">{w.amount}</td>
                <td className="p-2">{w.claimedAt}</td>
                <td className="p-2 font-mono text-xs">{w.txHash}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
