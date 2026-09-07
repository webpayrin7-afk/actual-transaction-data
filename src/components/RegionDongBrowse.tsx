"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { RegionBrowseResponse, RegionDongSummary } from "@/lib/molit/service";
import { regionDongHref } from "@/lib/molit/region-paths";

async function fetchRegionDongs(region: string): Promise<RegionBrowseResponse> {
  const qs = new URLSearchParams({ region });
  const res = await fetch(`/api/region-browse?${qs.toString()}`);
  if (!res.ok) throw new Error("failed");
  return res.json();
}

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
  });

  const data = query.data;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-500">
        동을 선택하면 해당 동의 단지 목록으로 이동합니다.
      </p>

      {query.isError && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          동 목록을 불러오지 못했습니다.
        </p>
      )}

      {query.isLoading && !data ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-2xl border border-slate-200 bg-slate-50"
            />
          ))}
        </div>
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
