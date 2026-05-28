/**
 * Typed-name confirmation gate (ACT-1128).
 *
 * GitHub-style destructive-action affordance: the operator types the
 * connected store's discriminator (PG database / SQLite file /
 * `"memory"`) before the "Wipe & Restore" button enables. The match
 * check lives in the parent so a single source of truth governs
 * button enablement; this component just renders the input and the
 * surrounding warning copy.
 */
export function DestructiveGate({
  target,
  value,
  onChange,
  disabled,
}: {
  target: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-4 rounded-md border border-red-900/50 bg-red-950/20 p-3">
      <p className="text-xs text-red-300">
        This will{" "}
        <span className="font-semibold">wipe all existing events</span> and
        replace them with the CSV. Type the connected store's name (
        <span className="font-mono text-red-200">{target}</span>) to enable.
      </p>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={target}
        className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-200 placeholder-zinc-600 focus:border-red-500 focus:outline-none disabled:opacity-50"
      />
    </div>
  );
}
