import { LabTag } from "@/components/ui/LabTag";
import type { ComplexHeroMetaLines } from "@/lib/complex-detail/hero-meta";

/**
 * 단지 요약 라벨 행 — 지역 현황 헤더(RegionHeroMeta)와 같은 LabTag md 묶음 (policy §12.2).
 * 위치는 제목 옆 titleSuffix로 가므로 여기서는 입주 · 세대 · 동 · 층 · 주차 · 용적률 · 건폐율 · 난방만.
 * 좁으면 태그 단위로 줄바꿈된다.
 */
export function ComplexHeroMeta({
  lines,
  extraTags = [],
}: {
  lines: ComplexHeroMetaLines;
  /** e.g. "가까운 초교 212m" — appended after the building facts */
  extraTags?: string[];
}) {
  // line1 = [full location?, 입주년도?] — location is shown as the title suffix instead.
  const tags = [
    ...lines.line1.filter((t) => /입주$/.test(t)),
    ...lines.line2,
    ...lines.line3,
    ...extraTags,
  ];
  if (tags.length === 0) return null;
  return (
    <div className="mt-2.5 flex flex-wrap gap-1" aria-label="단지 요약">
      {tags.map((t) => (
        <LabTag key={t} size="md">
          {t}
        </LabTag>
      ))}
    </div>
  );
}
