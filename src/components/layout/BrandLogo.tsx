import Image from "next/image";

/** 집랩 브랜드 로고 + 슬로건 */
export function BrandLogo({
  compact = false,
  priority = false,
}: {
  compact?: boolean;
  priority?: boolean;
}) {
  return (
    <span
      className={`flex shrink-0 items-center bg-white ${
        compact ? "h-10 gap-2 sm:h-11 sm:gap-2.5" : "h-[4.5rem] gap-3"
      }`}
    >
      <span
        className={`relative block shrink-0 overflow-hidden ${
          compact ? "h-10 w-[5.75rem] sm:h-11 sm:w-[6.25rem]" : "h-14 w-[8.5rem]"
        }`}
      >
        <Image
          src="/jiplab-logo.jpg"
          width={1280}
          height={524}
          alt="집랩"
          priority={priority}
          className="h-full w-full object-contain object-left"
        />
      </span>
      <span
        aria-hidden
        className={`shrink-0 self-center bg-slate-300 ${
          compact ? "h-7 w-px sm:h-8" : "h-10 w-px"
        }`}
      />
      <span
        className={`flex min-w-0 flex-col justify-center leading-tight text-slate-600 ${
          compact
            ? "text-[10px] font-medium tracking-tight sm:text-[11px]"
            : "text-xs font-medium tracking-tight sm:text-[13px]"
        }`}
      >
        <span className="whitespace-nowrap">데이터로 만드는</span>
        <span className="whitespace-nowrap">더 나은 주거의 내일</span>
      </span>
    </span>
  );
}
