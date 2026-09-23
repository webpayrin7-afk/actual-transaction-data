"use client";

import { useQuery } from "@tanstack/react-query";
import type { RegionMarketDetail } from "@/lib/region/region-market-detail";

export function useRegionMarketDetail(lawdCd: string | null) {
  return useQuery({
    queryKey: ["region-market-detail", lawdCd],
    queryFn: async () => {
      const res = await fetch(`/api/region-market-detail?lawd_cd=${lawdCd}`);
      if (!res.ok) throw new Error("detail");
      return (await res.json()) as RegionMarketDetail;
    },
    enabled: !!lawdCd,
    staleTime: 30 * 60_000,
    retry: 1,
  });
}
