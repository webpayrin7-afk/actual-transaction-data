"use client";

import { LabTag } from "@/components/ui/LabTag";
import { useRegionSummary } from "@/components/region/useRegionScopeQueries";
import type { RegionScope } from "@/lib/region/region-scope";

/** 지역(구·동) 요약 속성 라벨 (단지 수 · 세대 · 연식 · 주력 평형). */
export function RegionHeroMeta({ scope }: { scope: RegionScope | null }) {
  const query = useRegionSummary(scope);
  const data = query.data?.status === "ok" ? query.data : null;
  const tags = data
    ? [
        data.complexCount > 0 ? `${data.complexCount.toLocaleString("ko-KR")}개 단지` : null,
        data.householdTotal != null ? `${data.householdTotal.toLocaleString("ko-KR")}세대` : null,
        data.averageAgeYears != null ? `평균 ${Math.round(data.averageAgeYears)}년차` : null,
        data.representativeDecade ? `${data.representativeDecade.label} 중심` : null,
      ].filter((v): v is string => Boolean(v))
    : [];
  if (query.isError || (query.isSuccess && tags.length === 0)) return null;
  return (
    <div className="flex min-h-[26px] flex-wrap gap-1" aria-label="지역 요약">
      {tags.map((t) => (
        <LabTag key={t} size="md">
          {t}
        </LabTag>
      ))}
    </div>
  );
}
