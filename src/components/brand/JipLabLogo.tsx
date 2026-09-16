/**
 * Reusable 집랩 brand mark — house/building symbol + wordmark.
 * Navy + teal; no heavy gradients. Safe at small header sizes.
 */
export function JipLabLogo({
  className = "",
  markClassName = "",
  wordmarkClassName = "",
  title = "집랩",
}: {
  className?: string;
  markClassName?: string;
  wordmarkClassName?: string;
  title?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${className}`.trim()}
      aria-label={title}
    >
      <svg
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={`h-7 w-7 shrink-0 ${markClassName}`.trim()}
        aria-hidden
      >
        {/* Building mass — deep navy */}
        <path
          d="M6 28V12.5L16 5l10 7.5V28H6Z"
          fill="var(--lab-navy-900)"
        />
        {/* Left window band */}
        <rect x="9.2" y="14" width="3.2" height="3.2" rx="0.5" fill="#fff" opacity="0.92" />
        <rect x="9.2" y="19.2" width="3.2" height="3.2" rx="0.5" fill="#fff" opacity="0.92" />
        {/* Right window band */}
        <rect x="19.6" y="14" width="3.2" height="3.2" rx="0.5" fill="#fff" opacity="0.92" />
        <rect x="19.6" y="19.2" width="3.2" height="3.2" rx="0.5" fill="#fff" opacity="0.92" />
        {/* Teal accent door / entry */}
        <rect
          x="13.6"
          y="21.2"
          width="4.8"
          height="6.8"
          rx="0.6"
          fill="var(--lab-teal-600)"
        />
        {/* Teal roof edge highlight */}
        <path
          d="M6 12.5L16 5l10 7.5"
          stroke="var(--lab-teal-600)"
          strokeWidth="1.6"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
      <span
        className={`text-[1.125rem] font-bold tracking-tight text-[color:var(--lab-navy-900)] ${wordmarkClassName}`.trim()}
      >
        집랩
      </span>
    </span>
  );
}
