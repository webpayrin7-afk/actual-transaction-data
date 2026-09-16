import Image from "next/image";

/**
 * Reusable 집랩 brand logo (mark + wordmark as one asset).
 */
export function JipLabLogo({
  className = "",
  title = "집랩",
  priority = false,
}: {
  className?: string;
  /** @deprecated unused — kept for call-site compatibility */
  markClassName?: string;
  /** @deprecated unused — kept for call-site compatibility */
  wordmarkClassName?: string;
  title?: string;
  priority?: boolean;
}) {
  return (
    <span
      className={[
        "relative inline-flex items-center rounded-xl",
        "bg-gradient-to-r from-[color:var(--lab-teal-50)] via-[color:var(--lab-teal-50)]/50 to-transparent",
        "py-1 pr-2.5 pl-2",
        className,
      ]
        .join(" ")
        .trim()}
    >
      {/* Teal accent bar — ties logo to active nav tone */}
      <span
        aria-hidden
        className="absolute top-1/2 left-1 h-[58%] w-[3px] -translate-y-1/2 rounded-full bg-[color:var(--lab-teal-600)]"
      />
      <Image
        src="/brand/jiplab-logo.png"
        alt={title}
        width={1087}
        height={406}
        priority={priority}
        className="relative ml-1.5 h-10 w-auto"
      />
    </span>
  );
}
