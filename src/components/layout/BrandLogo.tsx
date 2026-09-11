import Image from "next/image";

/** 집랩 브랜드 로고 + 슬로건 (로고 크기는 기존과 동일) */
export function BrandLogo({
  compact = false,
  priority = false,
}: {
  compact?: boolean;
  priority?: boolean;
}) {
  return (
    <span className="flex shrink-0 items-center bg-white">
      <span
        className={`flex shrink-0 items-center justify-center ${
          compact ? "h-[56px] w-[138px]" : "h-[84px] w-[205px]"
        }`}
      >
        <Image
          src="/jiplab-logo.jpg"
          width={1280}
          height={524}
          alt="집랩"
          priority={priority}
          className="h-auto w-full object-contain"
        />
      </span>
      <span
        aria-hidden
        className={`-ml-2.5 shrink-0 self-center bg-slate-300 sm:-ml-3 ${
          compact ? "h-8 w-px" : "h-11 w-px"
        }`}
      />
      <span
        className={`ml-2 flex min-w-0 flex-col justify-center leading-tight text-slate-600 sm:ml-2.5 ${
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
