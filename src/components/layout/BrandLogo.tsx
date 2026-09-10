import Image from "next/image";

export function BrandLogo({ compact = false, priority = false }: { compact?: boolean; priority?: boolean }) {
  return (
    <span className={`flex shrink-0 items-center justify-center bg-white ${compact ? "h-[46px] w-[112px]" : "h-[66px] w-[162px]"}`}>
      <Image
        src="/jiplab-logo.jpg"
        width={1280}
        height={524}
        alt="집랩"
        priority={priority}
        className="h-auto w-full object-contain"
      />
    </span>
  );
}
