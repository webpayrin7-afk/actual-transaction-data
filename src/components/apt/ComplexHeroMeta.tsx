import type { ComplexHeroMetaLines } from "@/lib/complex-detail/hero-meta";

function HeroMetaLine({
  items,
  className,
}: {
  items: string[];
  className: string;
}) {
  if (items.length === 0) return null;
  return (
    <p className={`flex flex-wrap items-center ${className}`.trim()}>
      {items.map((item, index) => (
        <span key={`${index}-${item}`} className="inline-flex whitespace-nowrap">
          {index > 0 ? (
            <span className="px-1.5 text-slate-300" aria-hidden>
              ·
            </span>
          ) : null}
          {item}
        </span>
      ))}
    </p>
  );
}

export function ComplexHeroMeta({ lines }: { lines: ComplexHeroMetaLines }) {
  if (lines.line1.length + lines.line2.length + lines.line3.length === 0) {
    return null;
  }
  return (
    <div className="space-y-0.5">
      <HeroMetaLine
        items={lines.line1}
        className="text-[13px] leading-5 text-slate-600 sm:text-sm"
      />
      <HeroMetaLine
        items={lines.line2}
        className="text-[13px] leading-5 text-slate-600 sm:text-sm"
      />
      <HeroMetaLine
        items={lines.line3}
        className="text-xs leading-5 text-slate-500 sm:text-[13px]"
      />
    </div>
  );
}
