"use client";

/* rebuild-marker: drop dong-nav hint */

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useLoadProgressWhen } from "@/components/layout/LoadProgress";
import type { RegionBrowseResponse, RegionDongSummary } from "@/lib/molit/service";
import { regionDongHref } from "@/lib/molit/region-paths";
import { LAB_SECTION_SURFACE, LabSectionHeader } from "@/components/ui/LabSection";

async function fetchRegionDongs(region: string): Promise<RegionBrowseResponse> {
  const qs = new URLSearchParams({ region });
  const res = await fetch(`/api/region-browse?${qs.toString()}`);
  if (!res.ok) throw new Error("failed");
  return res.json();
}

const REGION_BROWSE_STALE_TIME_MS = 10 * 60 * 1000;

function DongCard({
  item,
  regionSlug,
}: {
  item: RegionDongSummary;
  regionSlug: string;
}) {
  return (
    <Link
      href={regionDongHref(regionSlug, item.dong, item.gu)}
      className="lab-press flex min-h-11 flex-col justify-center py-2.5 pl-3 pr-2 text-left"
    >
      <p className="flex items-center justify-between gap-1">
        <span className="detail-data-value-emphasis min-w-0 break-keep">{item.dong}</span>
        <ChevronRight className="lab-press-arrow h-4 w-4 shrink-0" aria-hidden />
      </p>
      <p className="detail-meta tabular-nums">단지 {item.aptCount.toLocaleString("ko-KR")}곳</p>
    </Link>
  );
}

export function RegionDongBrowse({ regionSlug }: { regionSlug: string }) {
  const query = useQuery({
    queryKey: ["region-browse", regionSlug],
    queryFn: () => fetchRegionDongs(regionSlug),
    staleTime: REGION_BROWSE_STALE_TIME_MS,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const data = query.data;
  useLoadProgressWhen(query.isLoading && !data, "동 목록 불러오는 중…");

  const dongs = data?.dongs ?? [];
  return (
    <section
      aria-label="동별 단지 탐색"
      className={`${LAB_SECTION_SURFACE} flex flex-col gap-3`}
    >
      <LabSectionHeader
        title="동별 단지 탐색"
        meta={dongs.length ? `${dongs.length.toLocaleString("ko-KR")}개 동` : undefined}
        tip={<p>동을 고르면 그 동에서 거래 이력이 있는 단지를 거래량 순으로 보여줍니다.</p>}
      />
      {query.isError ? (
        <p className="detail-body">동 목록을 불러오지 못했습니다.</p>
      ) : query.isLoading && !data ? (
        <div className="h-20 animate-pulse rounded-lg bg-slate-100" />
      ) : dongs.length === 0 ? (
        <p className="detail-body">표시할 동이 없습니다.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {dongs.map((item) => (
            <DongCard key={`${item.gu}-${item.dong}`} item={item} regionSlug={regionSlug} />
          ))}
        </div>
      )}
    </section>
  );
}
