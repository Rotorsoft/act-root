type LogoProps = {
  size?: number;
};

export function Logo({ size = 24 }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Blueprint grid */}
      <rect
        x="3"
        y="3"
        width="26"
        height="26"
        rx="3"
        stroke="currentColor"
        strokeWidth="2"
        className="text-blue-400"
      />
      {/* State block */}
      <rect
        x="7"
        y="7"
        width="8"
        height="6"
        rx="1.5"
        fill="currentColor"
        className="text-amber-400"
      />
      {/* Event block */}
      <rect
        x="17"
        y="7"
        width="8"
        height="6"
        rx="1.5"
        fill="currentColor"
        className="text-orange-500"
      />
      {/* Action block */}
      <rect
        x="7"
        y="19"
        width="8"
        height="6"
        rx="1.5"
        fill="currentColor"
        className="text-blue-500"
      />
      {/* Reaction arrow */}
      <path
        d="M17 22h5l-2-2M20 24l2-2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-purple-400"
      />
      {/* Connection lines */}
      <path
        d="M15 10h2M11 13v6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        className="text-zinc-500"
      />
    </svg>
  );
}
