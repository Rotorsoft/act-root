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
      {/* Magnifying glass body */}
      <circle
        cx="14"
        cy="14"
        r="9"
        stroke="currentColor"
        strokeWidth="2.5"
        className="text-emerald-400"
      />
      {/* Handle */}
      <line
        x1="21"
        y1="21"
        x2="28"
        y2="28"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="text-emerald-400"
      />
      {/* Event stream lines inside lens */}
      <path
        d="M9 11h4M9 14h6M9 17h3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        className="text-emerald-300"
      />
      {/* Dot accents */}
      <circle
        cx="17"
        cy="11"
        r="1.2"
        fill="currentColor"
        className="text-amber-400"
      />
      <circle
        cx="19"
        cy="14"
        r="1.2"
        fill="currentColor"
        className="text-sky-400"
      />
      <circle
        cx="16"
        cy="17"
        r="1.2"
        fill="currentColor"
        className="text-purple-400"
      />
    </svg>
  );
}
