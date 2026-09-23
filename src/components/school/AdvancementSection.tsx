"use client";

import { useState } from "react";
import { canRenderAdvancementSection } from "@/lib/school-info/advancement-disclosure";
import { advancementColorByRank } from "@/lib/school-info/advancement-category-colors";
import type { ProductAdvancementData } from "@/lib/school-info/product-school-detail";
import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import { LabDonut } from "@/components/ui/LabDonut";

type VisibleCategory = {
  key: string;
  label: string;
  count: number;
  percent: number | null;
  color: string;
};

/**
 * Presentation for middle 진학현황 / high 진학·진로현황.
 * 구성비 도넛(가운데 졸업생 수) + 항목 행(비율·인원 병기, 5개 + 더보기) — policy §12.4 / §12.7.
 * Consumes product AdvancementData only — no provider field / mapping logic.
 */
export function AdvancementSection({
  data,
  schoolKind,
}: {
  data: ProductAdvancementData | null | undefined;
  schoolKind: string | null | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const isMiddle = Boolean(schoolKind?.includes("중"));
  const isHigh = Boolean(schoolKind?.includes("고"));

  if (isMiddle && !canRenderAdvancementSection()) return null;
  if (!isMiddle && !isHigh) return null;
  if (!data) return null;

  const categories: VisibleCategory[] = data.categories
    .filter((c): c is typeof c & { count: number } => c.count != null && c.count > 0)
    .map((c) => ({ key: c.key, label: c.label, count: c.count, percent: c.percent, color: "" }))
    .sort((a, b) => b.count - a.count)
    .map((c, i) => ({ ...c, color: advancementColorByRank(i) }));

  if (!data.graduates?.value && categories.length === 0) return null;

  const meta = [
    data.year ? `${data.year}년 공시` : null,
    data.graduates?.value ? `졸업생 ${data.graduates.value}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const visible = expanded ? categories : categories.slice(0, LAB_LIST_PREVIEW);
  const hidden = categories.length - LAB_LIST_PREVIEW;

  return (
    <LabSection
      title={isHigh ? "진학·진로 현황" : "진학 현황"}
      meta={meta || undefined}
      tip="비율은 졸업생 수 기준입니다. 0명인 항목은 표시하지 않습니다."
    >
      {categories.length > 0 ? (
        <>
          <div className="flex justify-center">
            <LabDonut
              gaps={false}
              segments={categories.map((c) => ({
                key: c.key,
                value: c.percent ?? c.count,
                color: c.color,
                // 비율만 조각 위에 (항목명은 길어서 아래 목록에).
                label: "",
              }))}
              centerLabel="졸업생"
              centerValue={data.graduates?.value ?? undefined}
            />
          </div>
          <ul className={LAB_LIST}>
            {visible.map((c) => (
              <LabListRow
                key={c.key}
                title={
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: c.color }}
                      aria-hidden
                    />
                    <span className="truncate">{c.label}</span>
                  </span>
                }
                value={c.percent != null ? `${c.percent}%` : `${c.count.toLocaleString("ko-KR")}명`}
                sub={c.percent != null ? `${c.count.toLocaleString("ko-KR")}명` : undefined}
              />
            ))}
          </ul>
          {hidden > 0 ? (
            <LabMoreButton
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
              label={`${hidden}개 항목 더보기`}
            />
          ) : null}
        </>
      ) : null}

      {data.completeness === "partial" ? (
        <p className="detail-meta">
          일부 분류만 표시합니다. 표시 항목 합계가 졸업생 전체와 다를 수 있습니다.
        </p>
      ) : null}
    </LabSection>
  );
}
