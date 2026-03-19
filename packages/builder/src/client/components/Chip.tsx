import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip } from "./Tooltip.js";

type Props = {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  onClose?: () => void;
  closeTooltip?: string;
  disabled?: boolean;
  hoverClass?: string;
};

export function Chip({
  icon,
  label,
  onClick,
  onClose,
  closeTooltip,
  disabled,
  hoverClass = "",
}: Props) {
  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-1 truncate rounded-md border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 text-[9px] font-medium text-zinc-400 transition ${onClick ? "cursor-pointer" : ""} ${disabled ? "pointer-events-none opacity-50" : ""} ${hoverClass}`}
    >
      {icon}
      {label}
      {onClose && (
        <Tooltip title={closeTooltip || "Remove"}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="ml-0.5 flex items-center rounded-sm p-0.5 text-zinc-600 transition hover:bg-zinc-700 hover:text-red-400"
          >
            <X size={10} strokeWidth={2.5} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}
