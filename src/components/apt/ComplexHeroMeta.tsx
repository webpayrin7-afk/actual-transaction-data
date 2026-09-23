import { LabTag } from "@/components/ui/LabTag";
import type { ComplexHeroMetaLines } from "@/lib/complex-detail/hero-meta";

/**
 * 단지 요약 라벨 한 줄 — 지역 현황 헤더(RegionHeroMeta)와 같은 LabTag md 묶음 (policy §12.2).
 * 360px에서 한 줄이 되도록 핵심 4개(입주 · 세대 · 동 · 최고층)만 둔다.
 * 주차·용적률·건폐율·난방 등은 본문 "단지 정보" 섹션(ComplexInfoSection)으로.
 */
export function ComplexHeroMeta({ lines }: { lines: ComplexHeroMetaLines }) {
  const tags = [
    ...lines.line1.filter((t) => /입주$/.test(t)),
    ...lines.line2.filter((t) => !t.startsWith("주차")),
  ];
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-nowrap gap-1 overflow-hidden" aria-label="단지 요약">
      {tags.map((t) => (
        <LabTag key={t} size="md">
          {t}
        </LabTag>
      ))}
    </div>
  );
}
