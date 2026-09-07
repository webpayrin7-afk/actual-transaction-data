"use client";

/* rebuild-marker: drop apt-nav hint */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, MapPinned } from "lucide-react";
import { aptDetailHref } from "@/lib/molit/apt";
import type {
  RegionBrowseResponse,
  RegionDongApt,
} from "@/lib/molit/service";
import { formatDealDate, formatEok } from "@/lib/utils/format";

async function fetchRegionDongApts(params: {
  region: string;
  dong: string;
  gu?: string;
}): Promise<RegionBrowseResponse> {
  const qs = new URLSearchParams({
    region: params.region,
    dong: params.dong,
  });
  if (params.gu && params.gu !== "all") qs.set("gu", params.gu);
  const res = await fetch(`/api/region-browse?${qs.toString()}`);
  if (!res.ok) throw new Error("failed");
  return res.json();
}

function AptCard({
  item,
  regionSlug,
}: {
  item: RegionDongApt;
  regionSlug: string;
}) {
  return (
    <Link
      href={aptDetailHref(item.aptName, regionSlug, item.gu)}
      className="group flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-teal-300 hover:bg-teal-50/40"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-900 group-hover:text-teal-900">
          {item.aptName}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          {item.gu} · {item.dong}
          {item.buildYear ? ` · ${item.buildYear}년` : ""}
        </p>
        <p className="mt-2 text-xs text-slate-500">
          누적 매매 {item.dealCount.toLocaleString("ko-KR")}건
          {item.latestDealDate
            ? ` · 최근 ${formatDealDate(item.latestDealDate)}`
            : ""}
          {item.maxDealAmount > 0
            ? ` · 최고 ${formatEok(item.maxDealAmount)}`
            : ""}
        </p>
      </div>
      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-teal-700">
        단지 상세
        <ChevronRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

export function RegionDongAptList({
  regionSlug,
  regionName,
  dong,
  gu,
}: {
  regionSlug: string;
  regionName: string;
  dong: string;
  gu?: string;
}) {
  const query = useQuery({
    queryKey: ["region-browse-apts", regionSlug, dong, gu ?? ""],
    queryFn: () =>
      fetchRegionDongApts({
        region: regionSlug,
        dong,
        gu,
      }),
  });

  const data = query.data;
  const backHref = `/region/${regionSlug}?tab=dong`;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
      <header className="relative overflow-hidden rounded-2xl border border-teal-900/10 bg-gradient-to-br from-slate-900 via-teal-900 to-slate-800 px-4 py-4 text-white shadow-sm sm:px-5 sm:py-4">
        <div
          className="pointer-events-none absolute inset-0 opacity-25"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 20%, rgba(45,212,191,0.3), transparent 40%), radial-gradient(circle at 80% 0%, rgba(125,211,252,0.2), transparent 35%)",
          }}
        />
        <div className="relative min-w-0">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-2.5 py-0.5 text-[11px] font-medium text-teal-100 backdrop-blur">
              <MapPinned className="h-3 w-3" />
              {regionName}
              {gu ? ` · ${gu}` : ""}
            </div>
            <Link
              href={backHref}
              className="rounded-full border border-white/15 bg-white/10 px-2.5 py-0.5 text-[11px] font-medium text-teal-100 backdrop-blur transition hover:bg-white/20"
            >
              ← 동 목록으로
            </Link>
          </div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {dong} 단지 목록
          </h1>
        </div>
      </header>

      {query.isError && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          단지 목록을 불러오지 못했습니다.
        </p>
      )}

      {query.isLoading && !data ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-2xl border border-slate-200 bg-slate-50"
            />
          ))}
        </div>
      ) : (data?.apts.length ?? 0) === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
          이 동에서 찾은 단지가 없습니다.
        </p>
      ) : (
        <>
          <p className="text-sm text-slate-500">
            단지 {data!.apts.length.toLocaleString("ko-KR")}곳
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {data!.apts.map((apt) => (
              <AptCard
                key={`${apt.gu}-${apt.aptName}`}
                item={apt}
                regionSlug={regionSlug}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
