import Image from "next/image";

export function BrandLogo({ compact = false, priority = false }: { compact?: boolean; priority?: boolean }) {
  return (
    <span className={`relative block shrink-0 overflow-hidden bg-white ${compact ? "h-9 w-[112px]" : "h-14 w-[174px]"}`}>
      <Image
        src="/jiplab-logo.jpg"
        width={1280}
        height={524}
        alt="집랩"
        priority={priority}
        className={`absolute max-w-none ${compact ? "left-[-30px] top-[-13px] w-[174px]" : "left-[-47px] top-[-21px] w-[272px]"}`}
      />
    </span>
  );
}
