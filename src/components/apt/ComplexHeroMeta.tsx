import { LabTag } from "@/components/ui/LabTag";
import type { ComplexHeroMetaLines } from "@/lib/complex-detail/hero-meta";

/**
 * 단지 요약 라벨 — 지역 현황 헤더(RegionHeroMeta)와 같은 LabTag md 묶음 (policy §12.2).
 * 입주 · 세대 · 동 · 최고층 · 주차 · 용적률 · 건폐율 · 난방 · 관리 방식 · 구조. 태그 단위로 줄바꿈.
 * 아래 면적 선택 버튼과는 12px 띄운다.
 */
export function ComplexHeroMeta({
  lines,
  extraTags = [],
}: {
  lines: ComplexHeroMetaLines;
  /** 관리 방식 · 구조처럼 hero-meta 줄에 없는 값 */
  extraTags?: Array<string | null | undefined>;
}) {
  // 용적률·건폐율은 한 라벨로 묶어 줄바꿈으로 갈라지지 않게 한다.
  const ratios = lines.line3.filter((t) => /^(용적률|건폐율)/.test(t));
  const tags = [
    ...lines.line1.filter((t) => /입주$/.test(t)),
    ...lines.line2,
    ...(ratios.length ? [ratios.join(" · ")] : []),
    ...lines.line3.filter((t) => !/^(용적률|건폐율)/.test(t)),
    ...extraTags.filter((t): t is string => Boolean(t?.trim())),
  ];
  if (tags.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap gap-1" aria-label="단지 요약">
      {tags.map((t) => (
        <LabTag key={t} size="md">
          {t}
        </LabTag>
      ))}
    </div>
  );
}
