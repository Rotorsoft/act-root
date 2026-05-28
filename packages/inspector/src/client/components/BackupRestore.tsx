import { ArrowRightLeft } from "lucide-react";
import { useState } from "react";
import { TransferDialog } from "./transfer/index.js";

/**
 * Toolbar entry for the unified transfer dialog (ACT-1128 / #788).
 *
 * Pre-ACT-1128 the toolbar had three buttons (backup / restore /
 * transfer). They've all collapsed into one — the operator opens
 * the transfer dialog and picks source and target. The dialog's
 * default selection (`current → download`) reads as "backup the
 * connected store"; flipping to `upload → current` reads as
 * "restore from a local CSV"; everything else is just transfer.
 */
export function BackupRestore() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Transfer events (backup, restore, or cross-adapter migration)"
        className="rounded p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
      >
        <ArrowRightLeft size={14} />
      </button>
      {open && <TransferDialog onClose={() => setOpen(false)} />}
    </>
  );
}
