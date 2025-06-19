import React from "react";

interface PollCardProps {
  poll: {
    id: string;
    question: string | null;
    creator: string | null;
    closeTime: string | null;
    options?: string | null;
    outcome?: string | null;
  };
  children?: React.ReactNode;
}

export const PollCard: React.FC<PollCardProps> = ({ poll, children }) => {
  return (
    <div className="bg-white dark:bg-zinc-900 shadow rounded-lg p-4 mb-4 border border-zinc-200 dark:border-zinc-800 transition hover:shadow-lg">
      <div className="flex justify-between items-center mb-2">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          {poll.question ?? "No question"}
        </h2>
        <span className="text-xs text-zinc-500">
          ID: {poll.id.slice(0, 8)}...
        </span>
      </div>
      <div className="text-sm text-zinc-500 mb-1">
        By: {poll.creator ?? "Unknown"}
      </div>
      <div className="text-xs text-zinc-400 mb-2">
        Closes:{" "}
        {poll.closeTime ? new Date(poll.closeTime).toLocaleString() : "N/A"}
      </div>
      {poll.outcome && (
        <div className="text-xs font-bold text-green-600 dark:text-green-400 mb-2">
          Outcome: {poll.outcome}
        </div>
      )}
      {children}
    </div>
  );
};
