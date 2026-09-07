"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Building2, MapPinned } from "lucide-react";
import { aptDetailHref } from "@/lib/molit/apt";
import type {
  RegionBrowseResponse,
  RegionDongApt,
  RegionDongSummary,
} from "@/lib/molit/service";
import { formatDealDate, formatEok, yearMonthLabel } from "@/lib/utils/format";

async function fetchRegionBrowse(params: {
  region: string;
  yearMonth: string;
  dong?: string;
  gu?: string;
}): Promise<RegionBrowseResponse> {
  const qs = new URLSearchParams({
    region: params.region,
    yearMonth: params.yearMonth,
    months: "3",
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
        {item.gu} · 단지 {item.aptCount} · 거래 {item.dealCount}
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
      className="group flex flex-col rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-teal-300 hover:bg-teal-50/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900 group-hover:text-teal-900">
            {item.aptName}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {item.gu} · {item.dong}
            {item.buildYear ? ` · ${item.buildYear}년` : ""}
          </p>
        </div>
        <Building2 className="h-4 w-4 shrink-0 text-teal-600" />
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-xs text-slate-500">최근 거래</p>
          <p className="text-sm font-medium text-slate-700">
            {formatDealDate(item.latestDealDate)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-slate-500">
            거래 {item.dealCount}건
            {item.tradeCount > 0 ? ` · 매매 ${item.tradeCount}` : ""}
          </p>
          <p className="text-base font-semibold text-teal-700">
            {item.maxDealAmount > 0 ? formatEok(item.maxDealAmount) : "-"}
          </p>
        </div>
      </div>
    </Link>
  );
}

export function RegionDongBrowse({
  regionSlug,
  regionName,
  yearMonth,
  yearMonths,
  selectedDong,
  selectedGu,
  onYearMonthChange,
  onDongSelect,
  onBrowseDeals,
}: {
  regionSlug: string;
  regionName: string;
  yearMonth: string;
  yearMonths: string[];
  selectedDong: string | null;
  selectedGu: string | null;
  onYearMonthChange: (value: string) => void;
  onDongSelect: (dong: string | null, gu: string | null) => void;
  onBrowseDeals: (dong: string, gu: string) => void;
}) {
  const query = useQuery({
    queryKey: [
      "region-browse",
      regionSlug,
      yearMonth,
      selectedDong,
      selectedGu,
    ],
    queryFn: () =>
      fetchRegionBrowse({
        region: regionSlug,
        yearMonth,
        dong: selectedDong ?? undefined,
        gu: selectedGu ?? undefined,
      }),
  });

  const data = query.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-end sm:justify-between sm:p-5">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">동별 선택</h2>
          <p className="mt-1 text-sm text-slate-500">
            {regionName} 법정동을 고르면 해당 동 단지 목록을 보여줍니다.
          </p>
        </div>
        <label className="flex w-full flex-col gap-1.5 sm:max-w-[11rem]">
          <span className="text-xs font-medium text-slate-500">기준 계약월</span>
          <select
            value={yearMonth}
            onChange={(e) => onYearMonthChange(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20"
          >
            {yearMonths.map((ym) => (
              <option key={ym} value={ym}>
                {yearMonthLabel(ym)}
              </option>
            ))}
          </select>
        </label>
      </div>

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
                    onDongSelect(active ? null : item.dong, active ? null : item.gu)
                  }
                />
              );
            })}
          </div>

          {(data?.dongs.length ?? 0) === 0 && !query.isLoading && (
            <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
              표시할 동이 없습니다. 계약월을 바꿔 보세요.
            </p>
          )}

          {selectedDong && (
            <section className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
                    최근 거래 기준 · 단지 {data?.apts.length ?? 0}곳
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    onBrowseDeals(selectedDong, selectedGu ?? "all")
                  }
                  className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-sm font-medium text-teal-800 transition hover:bg-teal-100"
                >
                  이 동 거래 검색
                </button>
              </div>

              {query.isFetching && !data?.apts.length ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-28 animate-pulse rounded-2xl border border-slate-200 bg-slate-50"
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
