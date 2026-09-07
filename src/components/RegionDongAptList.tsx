"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, MapPinned } from "lucide-react";
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
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <div>
        <Link
          href={backHref}
          className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-slate-500 transition hover:text-teal-700"
        >
          <ArrowLeft className="h-4 w-4" />
          동 목록으로
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          <MapPinned className="h-6 w-6 text-teal-600" />
          {dong} 단지 목록
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          {regionName}
          {gu ? ` · ${gu}` : ""}
        </p>
      </div>

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
