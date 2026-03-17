import { Logo } from "./Logo.js";

type HeaderProps = {
  connected: boolean;
  connectionName: string;
  onConnect: () => void;
};

export function Header({ connected, connectionName, onConnect }: HeaderProps) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-925 px-4">
      <div className="flex items-center gap-2.5">
        <Logo size={22} />
        <h1 className="text-sm font-semibold tracking-wide text-zinc-300">
          <span className="text-emerald-400">act</span> inspector
        </h1>
      </div>
      <div className="flex items-center gap-3">
        {connected ? (
          <button
            onClick={onConnect}
            className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-750"
          >
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            {connectionName}
          </button>
        ) : (
          <button
            onClick={onConnect}
            className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-400 transition hover:border-zinc-600"
          >
            <span className="h-2 w-2 rounded-full bg-zinc-600" />
            Not connected
          </button>
        )}
      </div>
    </header>
  );
}
