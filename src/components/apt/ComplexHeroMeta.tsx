import { LabTag } from "@/components/ui/LabTag";
import type { ComplexHeroMetaLines } from "@/lib/complex-detail/hero-meta";

/**
 * 단지 요약 라벨 한 줄 — 지역 현황 헤더(RegionHeroMeta)와 같은 LabTag md 묶음 (policy §12.2).
 * 입주 · 세대 · 동 · 최고층 · 용적률 · 건폐율 — 360px에서 최대 2줄 (태그 단위 줄바꿈).
 * 주차·난방·관리 방식 등은 본문 "단지 정보" 섹션(ComplexInfoSection)으로.
 * 아래 면적 선택 버튼과는 12px 띄운다.
 */
export function ComplexHeroMeta({ lines }: { lines: ComplexHeroMetaLines }) {
  const tags = [
    ...lines.line1.filter((t) => /입주$/.test(t)),
    ...lines.line2.filter((t) => !t.startsWith("주차")),
    ...lines.line3.filter((t) => /^(용적률|건폐율)/.test(t)),
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
