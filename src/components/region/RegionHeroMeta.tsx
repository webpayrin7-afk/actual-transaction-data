"use client";

import { useQuery } from "@tanstack/react-query";
import { ComplexHeroMeta } from "@/components/apt/ComplexHeroMeta";
import { regionRankingCode } from "@/lib/region-ranking/public";
import type { RegionAptSummary } from "@/lib/region/region-summary";

/** 단지 상세 HERO와 같은 형식의 지역 소개 줄. */
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
  const present = (items: (string | null)[]) => items.filter((v): v is string => Boolean(v));
  const size = data
    ? present([
        data.complexCount > 0 ? `${data.complexCount.toLocaleString("ko-KR")}개 단지` : null,
        data.householdTotal != null ? `${data.householdTotal.toLocaleString("ko-KR")}세대` : null,
      ])
    : [];
  const character = data
    ? present([
        data.averageAgeYears != null ? `평균 ${data.averageAgeYears}년차` : null,
        data.representativeDecade ? `${data.representativeDecade.label} 중심` : null,
      ])
    : [];
  return <ComplexHeroMeta lines={{ line1: size, line2: character, line3: [] }} />;
}
