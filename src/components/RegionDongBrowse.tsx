"use client";

/* rebuild-marker: drop dong-nav hint */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useLoadProgressWhen } from "@/components/layout/LoadProgress";
import type { RegionBrowseResponse, RegionDongSummary } from "@/lib/molit/service";
import { regionDongHref } from "@/lib/molit/region-paths";

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
      className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-teal-300 hover:bg-teal-50/40"
    >
      <p className="text-sm font-semibold text-slate-900">{item.dong}</p>
      <p className="mt-1 text-xs text-slate-500">
        {item.gu} · 단지 {item.aptCount}
      </p>
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

  return (
    <div className="flex flex-col gap-4">
      {query.isError && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          동 목록을 불러오지 못했습니다.
        </p>
      )}

      {query.isLoading && !data ? (
        <div className="h-20 animate-pulse rounded-2xl border border-slate-200 bg-slate-50" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {(data?.dongs ?? []).map((item) => (
              <DongCard
                key={`${item.gu}-${item.dong}`}
                item={item}
                regionSlug={regionSlug}
              />
            ))}
          </div>

          {(data?.dongs.length ?? 0) === 0 && !query.isLoading && (
            <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
              표시할 동이 없습니다.
            </p>
          )}
        </>
      )}
    </div>
  );
}
