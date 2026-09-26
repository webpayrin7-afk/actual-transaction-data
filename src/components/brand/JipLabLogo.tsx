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
    <span className={`inline-flex items-center ${className}`.trim()}>
      <Image
        src="/brand/jiplab-logo.png"
        alt={title}
        width={1065}
        height={406}
        priority={priority}
        className="h-7 w-auto"
      />
    </span>
  );
}
