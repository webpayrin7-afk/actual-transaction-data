"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, MapPinned } from "lucide-react";
import { aptDetailHref } from "@/lib/molit/apt";
import type {
  RegionBrowseResponse,
  RegionDongApt,
  RegionDongSummary,
} from "@/lib/molit/service";
import { formatDealDate, formatEok } from "@/lib/utils/format";

async function fetchRegionBrowse(params: {
  region: string;
  dong?: string;
  gu?: string;
}): Promise<RegionBrowseResponse> {
  const qs = new URLSearchParams({
    region: params.region,
  });
  if (params.dong) qs.set("dong", params.dong);
  if (params.gu && params.gu !== "all") qs.set("gu", params.gu);
  const res = await fetch(`/api/region-browse?${qs.toString()}`);
  if (!res.ok) throw new Error("failed");
  return res.json();
}

function DongCard({
  item,
  active,
  onSelect,
}: {
  item: RegionDongSummary;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-2xl border px-4 py-3 text-left transition ${
        active
          ? "border-teal-500 bg-teal-50 shadow-sm"
          : "border-slate-200 bg-white hover:border-teal-300 hover:bg-teal-50/40"
      }`}
    >
      <p className="text-sm font-semibold text-slate-900">{item.dong}</p>
      <p className="mt-1 text-xs text-slate-500">
        {item.gu} · 단지 {item.aptCount}
      </p>
    </button>
  );
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

export function RegionDongBrowse({
  regionSlug,
  selectedDong,
  selectedGu,
  onDongSelect,
}: {
  regionSlug: string;
  selectedDong: string | null;
  selectedGu: string | null;
  onDongSelect: (dong: string | null, gu: string | null) => void;
}) {
  const query = useQuery({
    queryKey: ["region-browse", regionSlug, selectedDong, selectedGu],
    queryFn: () =>
      fetchRegionBrowse({
        region: regionSlug,
        dong: selectedDong ?? undefined,
        gu: selectedGu ?? undefined,
      }),
  });

  const data = query.data;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-500">
        동을 고른 뒤 단지를 누르면 단지 상세로 이동합니다.
      </p>

      {query.isError && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          동별 단지 목록을 불러오지 못했습니다.
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
            {(data?.dongs ?? []).map((item) => {
              const active =
                selectedDong === item.dong && selectedGu === item.gu;
              return (
                <DongCard
                  key={`${item.gu}-${item.dong}`}
                  item={item}
                  active={active}
                  onSelect={() =>
                    onDongSelect(
                      active ? null : item.dong,
                      active ? null : item.gu,
                    )
                  }
                />
              );
            })}
          </div>

          {(data?.dongs.length ?? 0) === 0 && !query.isLoading && (
            <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
              표시할 동이 없습니다.
            </p>
          )}

          {selectedDong && (
            <section className="flex flex-col gap-3">
              <div>
                <button
                  type="button"
                  onClick={() => onDongSelect(null, null)}
                  className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-teal-700"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  동 목록으로
                </button>
                <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
                  <MapPinned className="h-4 w-4 text-teal-600" />
                  {selectedDong} 단지 목록
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  단지 {data?.apts.length ?? 0}곳 · 단지를 누르면 상세로
                  이동합니다
                </p>
              </div>

              {query.isFetching && !data?.apts.length ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {Array.from({ length: 4 }).map((_, i) => (
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
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {data!.apts.map((apt) => (
                    <AptCard
                      key={`${apt.gu}-${apt.aptName}`}
                      item={apt}
                      regionSlug={regionSlug}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
