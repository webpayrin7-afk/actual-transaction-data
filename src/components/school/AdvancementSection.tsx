"use client";

import { canRenderAdvancementSection } from "@/lib/school-info/advancement-disclosure";
import type { ProductAdvancementData } from "@/lib/school-info/product-school-detail";
import { LabSection } from "@/components/ui/LabSection";
import { LabShareBars } from "@/components/ui/LabShareBars";

type VisibleCategory = {
  key: string;
  label: string;
  count: number;
  percent: number | null;
};

/**
 * Presentation for middle 진학현황 / high 진학·진로현황.
 * 정렬된 가로 막대(LabShareBars): 항목마다 이름 · 비율 · 인원 + 막대, 5개 + 더보기 — policy §12.4 / §12.7.
 * (도넛은 78% + 여러 개의 한 자릿수 조각이라 작은 값 표시가 어려워 쓰지 않는다.)
 * Consumes product AdvancementData only — no provider field / mapping logic.
 */
export function AdvancementSection({
  data,
  schoolKind,
}: {
  data: ProductAdvancementData | null | undefined;
  schoolKind: string | null | undefined;
}) {
  const isMiddle = Boolean(schoolKind?.includes("중"));
  const isHigh = Boolean(schoolKind?.includes("고"));

  if (isMiddle && !canRenderAdvancementSection()) return null;
  if (!isMiddle && !isHigh) return null;
  if (!data) return null;

  const categories: VisibleCategory[] = data.categories
    .filter((c): c is typeof c & { count: number } => c.count != null && c.count > 0)
    .map((c) => ({ key: c.key, label: c.label, count: c.count, percent: c.percent }))
    .sort((a, b) => b.count - a.count);

  if (!data.graduates?.value && categories.length === 0) return null;

  const meta = [
    data.year ? `${data.year}년 공시` : null,
    data.graduates?.value ? `졸업생 ${data.graduates.value}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <LabSection
      title={isHigh ? "진학·진로 현황" : "진학 현황"}
      meta={meta || undefined}
      tip="비율은 졸업생 수 기준입니다. 0명인 항목은 표시하지 않습니다."
    >
      {categories.length > 0 ? (
        <LabShareBars
          items={categories.map((c) => ({
            key: c.key,
            label: c.label,
            value: c.count,
            percent: c.percent,
            sub: `${c.count.toLocaleString("ko-KR")}명`,
          }))}
          moreLabel={(n) => `${n}개 항목 더보기`}
        />
      ) : null}

      {data.completeness === "partial" ? (
        <p className="detail-meta">
          일부 분류만 표시합니다. 표시 항목 합계가 졸업생 전체와 다를 수 있습니다.
        </p>
      ) : null}
    </LabSection>
  );
}
