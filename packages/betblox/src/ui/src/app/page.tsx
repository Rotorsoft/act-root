import Image from "next/image";

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-zinc-950 to-zinc-900 text-zinc-100 p-6">
      {/* Hero Section */}
      <section className="w-full max-w-2xl text-center mt-16 mb-12">
        <h1 className="text-5xl font-extrabold tracking-tight mb-4 text-blue-400">
          BetBlox
        </h1>
        <h2 className="text-xl font-semibold mb-4 text-zinc-200">
          The open, decentralized prediction market for everyone
        </h2>
        <p className="mb-8 text-zinc-400">
          Create and join markets on real-world events. Bet, compete, and win in
          a transparent, trustless environment—no middlemen, no limits.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <a
            href="/poll/create"
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-semibold shadow transition"
          >
            Create Market
          </a>
          <a
            href="/my-bets"
            className="bg-zinc-800 hover:bg-zinc-700 text-zinc-100 px-6 py-3 rounded-lg font-semibold border border-zinc-700 transition"
          >
            My Bets
          </a>
        </div>
      </section>

      {/* How it Works */}
      <section className="w-full max-w-3xl mb-16">
        <h3 className="text-2xl font-bold mb-6 text-blue-300 text-center">
          How it works
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
          <div className="flex flex-col items-center">
            <div className="bg-blue-900 rounded-full w-16 h-16 flex items-center justify-center mb-3">
              <span className="text-3xl">📝</span>
            </div>
            <h4 className="font-semibold mb-1">Create a Market</h4>
            <p className="text-zinc-400 text-sm">
              Start a new prediction market on any event—sports, politics,
              crypto, and more.
            </p>
          </div>
          <div className="flex flex-col items-center">
            <div className="bg-blue-900 rounded-full w-16 h-16 flex items-center justify-center mb-3">
              <span className="text-3xl">🗳️</span>
            </div>
            <h4 className="font-semibold mb-1">Bet & Compete</h4>
            <p className="text-zinc-400 text-sm">
              Place your bets, challenge others, and track the odds in real
              time.
            </p>
          </div>
          <div className="flex flex-col items-center">
            <div className="bg-blue-900 rounded-full w-16 h-16 flex items-center justify-center mb-3">
              <span className="text-3xl">🏆</span>
            </div>
            <h4 className="font-semibold mb-1">Win & Withdraw</h4>
            <p className="text-zinc-400 text-sm">
              Winners claim instant payouts when the event resolves—no delays,
              no disputes.
            </p>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="w-full max-w-3xl mb-12">
        <h3 className="text-2xl font-bold mb-6 text-blue-300 text-center">
          Why BetBlox?
        </h3>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-6 text-zinc-300">
          <li className="bg-zinc-800 rounded-lg p-5 border border-zinc-700">
            <span className="font-bold text-blue-400">Decentralized</span>
            <br />
            No central authority—markets are open, transparent, and
            censorship-resistant.
          </li>
          <li className="bg-zinc-800 rounded-lg p-5 border border-zinc-700">
            <span className="font-bold text-blue-400">Transparent</span>
            <br />
            All bets and outcomes are public and verifiable by anyone.
          </li>
          <li className="bg-zinc-800 rounded-lg p-5 border border-zinc-700">
            <span className="font-bold text-blue-400">Fast payouts</span>
            <br />
            Winners receive their rewards instantly when the market resolves.
          </li>
          <li className="bg-zinc-800 rounded-lg p-5 border border-zinc-700">
            <span className="font-bold text-blue-400">Open to all</span>
            <br />
            Anyone can create or join a market—no KYC, no barriers.
          </li>
        </ul>
      </section>
    </div>
  );
}
