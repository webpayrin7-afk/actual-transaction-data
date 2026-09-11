import Image from "next/image";

/** 집랩 브랜드 로고 — 헤더(compact) / 사이드바 */
export function BrandLogo({
  compact = false,
  priority = false,
}: {
  compact?: boolean;
  priority?: boolean;
}) {
  return (
    <span
      className={`relative block shrink-0 overflow-hidden bg-white ${
        compact ? "h-10 w-[9.5rem] sm:h-11 sm:w-[10.5rem]" : "h-[4.5rem] w-[15.5rem]"
      }`}
    >
      <Image
        src="/jiplab-logo.jpg"
        width={2075}
        height={758}
        alt="집랩"
        priority={priority}
        className="h-full w-full object-contain object-left"
      />
    </span>
  );
}
