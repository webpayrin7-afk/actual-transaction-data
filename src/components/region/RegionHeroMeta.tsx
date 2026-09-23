"use client";

import { useQuery } from "@tanstack/react-query";
import { LabTag } from "@/components/ui/LabTag";
import { regionRankingCode } from "@/lib/region-ranking/public";
import type { RegionAptSummary } from "@/lib/region/region-summary";

/** 지역 요약 속성 라벨 (단지 수 · 세대 · 연식 · 주력 평형). */
export function RegionHeroMeta({ lawdCodes }: { lawdCodes: string[] }) {
  const lawdCd = regionRankingCode(lawdCodes);
  const query = useQuery({
    queryKey: ["region-summary", lawdCd],
    queryFn: async () => {
      const res = await fetch(`/api/region-summary?lawd_cd=${lawdCd}`);
      if (!res.ok) throw new Error("summary");
      return (await res.json()) as RegionAptSummary;
    },
    enabled: !!lawdCd,
    staleTime: 60 * 60_000,
    retry: 1,
  });
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
