import Image from "next/image";

/** 집랩 브랜드 로고 + 슬로건 (PC 사이드바) */
export function BrandLogo({
  compact = false,
  priority = false,
}: {
  compact?: boolean;
  priority?: boolean;
}) {
  return (
    <span className="flex shrink-0 items-center bg-white">
      {/* Same asset as the mobile header (JipLabLogo) — tight crop, no built-in padding. */}
      <Image
        src="/brand/jiplab-logo.png"
        width={1065}
        height={406}
        alt="집랩"
        priority={priority}
        className={`w-auto shrink-0 ${compact ? "h-7" : "h-9"}`}
      />
      <span
        aria-hidden
        className={`mx-1.5 -translate-x-px shrink-0 self-center bg-slate-300 sm:mx-2 ${
          compact ? "h-8 w-px" : "h-11 w-px"
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
