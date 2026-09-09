"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, MapPinned } from "lucide-react";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { PixelSeoulMap } from "@/components/leader-map/PixelSeoulMap";
import type { GuLeaderRow, LeaderComplex, LeaderMapResponse } from "@/lib/leader-map/types";
import { formatDealDate, formatEok, formatSqm } from "@/lib/utils/format";

async function fetchLeaderMap(): Promise<LeaderMapResponse> {
  const res = await fetch("/api/leader-map?region=seoul");
  if (!res.ok) throw new Error("대장 아파트 지도를 불러오지 못했습니다.");
  return res.json();
}

function formatPyeongEok(manwon: number): string {
  return formatEok(manwon);
}

function LeaderMeta({ leader }: { leader: LeaderComplex }) {
  return (
    <div className="space-y-2 text-sm">
      <p className="text-lg font-semibold tracking-tight text-slate-900">
        {leader.aptName}
      </p>
      <p className="text-xs text-slate-500">
        {leader.gu} {leader.dong}
      </p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[13px]">
        <div>
          <dt className="text-xs text-slate-500">84㎡ 환산</dt>
          <dd className="font-semibold tabular-nums text-slate-900">
            {formatEok(leader.normalized84Price)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">평당 중위가</dt>
          <dd className="font-semibold tabular-nums text-slate-900">
            {formatPyeongEok(leader.medianPyeongPrice)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">최근 거래</dt>
          <dd className="tabular-nums text-slate-800">
            {formatEok(leader.latestDeal.dealAmount)} ·{" "}
            {formatSqm(leader.latestDeal.exclusiveArea)} ·{" "}
            {formatDealDate(leader.latestDeal.dealDate)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">거래 표본</dt>
          <dd className="text-slate-800">
            {leader.tradeCount12m}건
            {leader.sampleQuality === "LOW" ? (
              <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                표본 적음
              </span>
            ) : null}
          </dd>
        </div>
      </dl>
      {leader.latestChange && leader.previousDeal ? (
        <p
          className={`text-xs font-medium ${
            leader.latestChange.direction === "up"
              ? "text-rose-600"
              : leader.latestChange.direction === "down"
                ? "text-teal-700"
                : "text-slate-500"
          }`}
        >
          같은 면적 직전 거래 대비{" "}
          {leader.latestChange.direction === "up"
            ? "↑"
            : leader.latestChange.direction === "down"
              ? "↓"
              : "·"}{" "}
          {leader.latestChange.direction === "same"
            ? "동일"
            : `${leader.latestChange.direction === "down" ? "-" : "+"}${formatEok(leader.latestChange.amount)}${
                leader.latestChange.pct != null
                  ? ` (${leader.latestChange.pct > 0 ? "+" : ""}${leader.latestChange.pct}%)`
                  : ""
              }`}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2 pt-1">
        <Link
          href={leader.href}
          className="inline-flex items-center gap-1 rounded-lg bg-teal-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-800"
        >
          단지 보기
          <ArrowRight className="h-3 w-3" />
        </Link>
        <Link
          href={`/region/${leader.regionSlug}`}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          {leader.gu} 자세히 보기
        </Link>
      </div>
    </div>
  );
}

function GuList({
  gus,
  selectedSlug,
  onSelect,
}: {
  gus: GuLeaderRow[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
}) {
  return (
    <ul className="divide-y divide-slate-100">
      {gus.map((row) => {
        const active = row.slug === selectedSlug;
        return (
          <li key={row.slug}>
            <button
              type="button"
              id={`gu-${row.slug}`}
              onClick={() => onSelect(row.slug)}
              className={`flex w-full items-start justify-between gap-2 px-3 py-2.5 text-left text-sm ${
                active ? "bg-teal-50" : "hover:bg-slate-50"
              }`}
            >
              <span className="min-w-0">
                <span className="block font-medium text-slate-900">{row.name}</span>
                <span className="block truncate text-xs text-slate-500">
                  {row.leader ? row.leader.aptName : "최근 거래 표본 부족"}
                </span>
              </span>
              <span className="shrink-0 text-right">
                {row.leader ? (
                  <span className="block text-xs font-semibold tabular-nums text-slate-800">
                    {formatEok(row.leader.normalized84Price)}
                  </span>
                ) : (
                  <span className="text-[11px] text-slate-400">대장 없음</span>
                )}
                {row.leader?.sampleQuality === "LOW" ? (
                  <span className="text-[10px] text-amber-700">표본 적음</span>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function LeaderMapPage() {
  const query = useQuery({
    queryKey: ["leader-map", "seoul"],
    queryFn: fetchLeaderMap,
    staleTime: 30 * 60 * 1000,
  });
  const data = query.data;
  const defaultSlug =
    data?.gus.find((g) => g.slug === "seoul-gangnam" && g.leader)?.slug ??
    data?.gus.find((g) => g.leader)?.slug ??
    data?.gus[0]?.slug ??
    null;
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const slug = selectedSlug ?? defaultSlug;
  const selected = useMemo(
    () => data?.gus.find((g) => g.slug === slug) ?? null,
    [data, slug],
  );
  const dongs = selected ? (data?.dongsByGu[selected.name] ?? []) : [];

  return (
    <div className={`${PAGE_SHELL} overflow-x-hidden`}>
      <PageHeader
        title="서울 대장 아파트 지도"
        description="지도에서 보는 우리 동네 대표 아파트. 최근 12개월 매매 실거래의 면적당 가격을 84㎡로 환산해 비교합니다."
        meta={
          data ? (
            <p>
              계약일 {data.window.from.replaceAll("-", ".")} ~{" "}
              {data.window.to.replaceAll("-", ".")}
              {data.asOfDate ? ` · 최근 계약 ${data.asOfDate.replaceAll("-", ".")}` : ""}
              {` · 표본 충족 단지 ${data.eligibleComplexCount.toLocaleString("ko-KR")}곳`}
            </p>
          ) : null
        }
      />

      {query.isLoading ? (
        <div className="h-72 animate-pulse rounded-2xl border border-slate-200 bg-slate-100" />
      ) : null}

      {query.isError ? (
        <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {(query.error as Error).message}
        </p>
      ) : null}

      {data ? (
        <>
          <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
            <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <div className="border-b border-slate-100 px-4 py-3">
                <h2 className="text-sm font-semibold text-slate-900">서울 25개 구</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  구를 선택하면 동별 대장과 단지 상세로 이동합니다.
                </p>
              </div>
              <div className="max-h-[28rem] overflow-y-auto lg:max-h-[34rem]">
                <GuList
                  gus={data.gus}
                  selectedSlug={slug}
                  onSelect={setSelectedSlug}
                />
              </div>
            </section>

            <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-800 bg-[#071422]">
              <div className="flex items-center justify-between gap-2 px-4 py-3 text-slate-200">
                <div className="flex items-center gap-2">
                  <MapPinned className="h-4 w-4 text-teal-300" />
                  <h2 className="text-sm font-semibold">서울 픽셀 지도</h2>
                </div>
                <p className="text-[11px] text-slate-400">한강 기준 · 행정경계 아님</p>
              </div>
              <div className="w-full max-w-full overflow-hidden px-2 pb-3 sm:px-3">
                <PixelSeoulMap
                  gus={data.gus}
                  selectedSlug={slug}
                  onSelect={setSelectedSlug}
                />
              </div>
              {selected?.leader ? (
                <div className="hidden border-t border-slate-700 px-4 py-3 text-xs text-slate-300 sm:block">
                  <span className="text-amber-300">{selected.name}</span>
                  {" · "}
                  {selected.leader.aptName}
                  {" · "}
                  {formatEok(selected.leader.normalized84Price)}
                  {" · 최근 "}
                  {formatEok(selected.leader.latestDeal.dealAmount)}
                </div>
              ) : null}
            </section>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
            <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
              {selected ? (
                <>
                  <h2 className="text-sm font-semibold text-slate-900">
                    {selected.name} 대장 아파트
                  </h2>
                  <div className="mt-3">
                    {selected.leader ? (
                      <LeaderMeta leader={selected.leader} />
                    ) : (
                      <p className="text-sm text-slate-500">최근 거래 표본 부족</p>
                    )}
                  </div>
                  <h3 className="mt-6 text-sm font-semibold text-slate-900">
                    {selected.name} 동별 대장
                  </h3>
                  {dongs.length === 0 ? (
                    <p className="mt-2 text-sm text-slate-500">동별 표본이 없습니다.</p>
                  ) : (
                    <ul className="mt-2 divide-y divide-slate-100">
                      {dongs.map((row) => (
                        <li
                          key={row.dong}
                          className="flex items-center justify-between gap-3 py-2.5"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-slate-800">{row.dong}</p>
                            {row.leader ? (
                              <Link
                                href={row.leader.href}
                                className="truncate text-xs text-teal-700 hover:underline"
                              >
                                {row.leader.aptName}
                              </Link>
                            ) : (
                              <p className="text-xs text-slate-400">표본 부족</p>
                            )}
                          </div>
                          {row.leader ? (
                            <span className="shrink-0 text-xs font-semibold tabular-nums text-slate-700">
                              {formatEok(row.leader.normalized84Price)}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : null}
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
              <h2 className="text-sm font-semibold text-slate-900">서울 대장 TOP 5</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                구 대표가 아니라 서울 전체 표본 충족 단지 기준입니다.
              </p>
              <ol className="mt-3 space-y-2">
                {data.top5.map((item, i) => (
                  <li key={item.complexKey}>
                    <Link
                      href={item.href}
                      className="flex items-start justify-between gap-2 rounded-lg px-1 py-1.5 hover:bg-slate-50"
                    >
                      <span className="min-w-0">
                        <span className="mr-1.5 text-xs font-semibold text-amber-700">
                          {i + 1}
                        </span>
                        <span className="text-sm font-medium text-slate-900">
                          {item.aptName}
                        </span>
                        <span className="mt-0.5 block text-xs text-slate-500">
                          {item.gu} {item.dong}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs font-semibold tabular-nums text-slate-800">
                        {formatEok(item.normalized84Price)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          </div>

          <p className="text-xs leading-5 text-slate-500">
            대장 아파트는 최근 실거래 데이터를 바탕으로 같은 기준에서 비교한
            데이터랩의 대표 단지 지표입니다. 공식 지정이나 투자 추천을 의미하지
            않습니다. 최근 12개월 매매 실거래의 면적당 가격을 84㎡로 환산하고,
            거래 표본(원칙 5건, 부족 시 3건·1건)을 충족한 단지 중에서 고릅니다.
          </p>
        </>
      ) : null}
    </div>
  );
}
