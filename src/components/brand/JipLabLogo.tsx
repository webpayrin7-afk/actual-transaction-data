import Image from "next/image";

/**
 * Reusable 집랩 brand — provided mark + wordmark assets.
 */
export function JipLabLogo({
  className = "",
  markClassName = "",
  wordmarkClassName = "",
  title = "집랩",
  priority = false,
}: {
  className?: string;
  markClassName?: string;
  wordmarkClassName?: string;
  title?: string;
  priority?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${className}`.trim()}
      aria-label={title}
    >
      <Image
        src="/brand/jiplab-mark.png"
        alt=""
        width={711}
        height={626}
        priority={priority}
        className={`h-7 w-auto shrink-0 ${markClassName}`.trim()}
        aria-hidden
      />
      <Image
        src="/brand/jiplab-wordmark.png"
        alt={title}
        width={925}
        height={402}
        priority={priority}
        className={`h-6 w-auto shrink-0 ${wordmarkClassName}`.trim()}
      />
    </span>
  );
}
