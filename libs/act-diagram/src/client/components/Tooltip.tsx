import { useCallback, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type DetailItem = {
  label: string;
  text: string;
};

type Props = {
  title: string;
  description?: string;
  details?: DetailItem[];
  children: ReactNode;
  position?: "top" | "bottom";
  align?: "center" | "right" | "left";
};

export function Tooltip({
  title,
  description,
  details,
  children,
  position = "bottom",
  align = "center",
}: Props) {
  const [show, setShow] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0, w: 0 });
  const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const ref = useRef<HTMLDivElement>(null);

  const onEnter = useCallback(() => {
    timeout.current = setTimeout(() => {
      if (ref.current) {
        const r = ref.current.getBoundingClientRect();
        setCoords({
          x: r.left,
          y: position === "top" ? r.top : r.bottom,
          w: r.width,
        });
      }
      setShow(true);
    }, 400);
  }, [position]);

  const onLeave = useCallback(() => {
    clearTimeout(timeout.current);
    setShow(false);
  }, []);

  const left =
    align === "right"
      ? undefined
      : align === "left"
        ? coords.x
        : coords.x + coords.w / 2;
  const right =
    align === "right" ? window.innerWidth - coords.x - coords.w : undefined;

  return (
    <div
      ref={ref}
      className="relative inline-flex"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {children}
      {show &&
        createPortal(
          <div
            className={`pointer-events-none fixed z-[100] rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl ${
              details ? "w-80 px-3.5 py-3" : "max-w-52 px-2.5 py-1.5"
            } ${align === "center" ? "-translate-x-1/2" : ""}`}
            style={{
              top: position === "top" ? undefined : coords.y + 6,
              bottom:
                position === "top"
                  ? window.innerHeight - coords.y + 6
                  : undefined,
              left,
              right,
            }}
          >
            <div className="text-[11px] font-semibold text-zinc-100">
              {title}
            </div>
            {description && (
              <div className="mt-0.5 text-[10px] leading-relaxed text-zinc-500">
                {description}
              </div>
            )}
            {details && details.length > 0 && (
              <table className="mt-2 w-full border-t border-zinc-800 text-[10px] leading-snug">
                <tbody>
                  {details.map((d, i) => (
                    <tr key={i} className={i === 0 ? "first:*:pt-2" : ""}>
                      <td className="w-[52px] shrink-0 pr-2 pt-1.5 text-right align-top font-medium text-zinc-400">
                        {d.label}
                      </td>
                      <td className="pt-1.5 align-top text-zinc-500">
                        {d.text}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
