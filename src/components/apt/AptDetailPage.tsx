"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  Building2,
  CalendarDays,
  Flame,
  MapPin,
} from "lucide-react";
import type { AptDetailResponse } from "@/lib/molit/apt";
import {
  formatDealDate,
  formatEok,
  toPyeong,
} from "@/lib/utils/format";

async function fetchAptDetail(
  aptName: string,
  region: string,
): Promise<AptDetailResponse> {
  const qs = new URLSearchParams({ aptName, region, months: "12" });
  const res = await fetch(`/api/apt-detail?${qs.toString()}`);
  if (!res.ok) throw new Error("failed");
  return res.json();
}

function groupByYear(items: AptDetailResponse["items"]) {
  const map = new Map<string, AptDetailResponse["items"]>();
  for (const item of items) {
    const year = item.dealDate.slice(0, 4);
    const list = map.get(year) ?? [];
    list.push(item);
    map.set(year, list);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
}

export function AptDetailPage({
  aptName,
  regionSlug,
}: {
  aptName: string;
  regionSlug: string;
}) {
  const [areaKey, setAreaKey] = useState("all");
  const query = useQuery({
    queryKey: ["apt-detail", aptName, regionSlug],
    queryFn: () => fetchAptDetail(aptName, regionSlug),
  });

  const data = query.data;
  const filtered = useMemo(() => {
    if (!data) return [];
    if (areaKey === "all") return data.items;
    return data.items.filter(
      (item) => String(Math.round(item.exclusiveArea * 100) / 100) === areaKey,
    );
  }, [data, areaKey]);

  const grouped = useMemo(() => groupByYear(filtered), [filtered]);

  if (query.isLoading) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8 sm:px-6">
        <div className="h-40 animate-pulse rounded-3xl bg-slate-200/70" />
        <div className="h-24 animate-pulse rounded-2xl bg-slate-200/60" />
        <div className="h-96 animate-pulse rounded-2xl bg-slate-200/50" />
      </div>
    );
  }

  if (query.isError || !data) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-16 text-center sm:px-6">
        <p className="text-sm font-medium text-slate-700">
          단지 정보를 불러오지 못했습니다.
        </p>
        <Link href="/" className="text-sm text-teal-700 hover:underline">
          ← 메인으로
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link
          href="/"
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-slate-600 hover:bg-slate-100"
        >
          <ArrowLeft className="h-4 w-4" />
          메인
        </Link>
        <span className="text-slate-300">/</span>
        <Link
          href={`/region/${data.regionSlug}`}
          className="rounded-lg px-2 py-1 text-slate-600 hover:bg-slate-100"
        >
          {data.regionName}
        </Link>
      </div>

      <header className="relative overflow-hidden rounded-3xl border border-teal-900/10 bg-gradient-to-br from-slate-900 via-teal-900 to-slate-800 px-5 py-7 text-white shadow-lg sm:px-8">
        <div
          className="pointer-events-none absolute inset-0 opacity-30"
          style={{
            backgroundImage:
              "radial-gradient(circle at 18% 20%, rgba(45,212,191,0.35), transparent 42%), radial-gradient(circle at 85% 0%, rgba(125,211,252,0.22), transparent 36%)",
          }}
        />
        <div className="relative">
          <p className="text-sm text-teal-100/85">아파트 실거래가 이력</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            {data.aptName}
            {data.buildYear ? (
              <span className="ml-2 text-lg font-medium text-teal-100/80">
                ({data.buildYear}년)
              </span>
            ) : null}
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-teal-50/85">
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-4 w-4" />
              {data.fullName}
              {data.dong ? ` ${data.dong}` : ""}
            </span>
            <span className="inline-flex items-center gap-1">
              <Building2 className="h-4 w-4" />
              최근 12개월 매매 {data.stats.totalTradeCount.toLocaleString("ko-KR")}건
            </span>
          </p>
        </div>
      </header>

      {(data.warning || data.source === "mock") && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {data.warning ??
              "데모 데이터로 표시 중입니다. MOLIT_API_KEY 설정 시 실거래가 반영됩니다."}
          </p>
        </div>
      )}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <article className="rounded-2xl border border-slate-200/80 bg-white/85 p-4 shadow-sm">
          <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
            3개월 거래
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">
            {data.stats.recent3mCount.toLocaleString("ko-KR")}
            <span className="ml-1 text-sm font-medium text-slate-500">건</span>
          </p>
        </article>
        <article className="rounded-2xl border border-rose-200/80 bg-rose-50/70 p-4 shadow-sm">
          <p className="text-xs font-medium tracking-wide text-rose-700 uppercase">
            최고가
          </p>
          <p className="mt-2 text-2xl font-semibold text-rose-700">
            {formatEok(data.stats.maxDealAmount)}
          </p>
        </article>
        <article className="rounded-2xl border border-slate-200/80 bg-white/85 p-4 shadow-sm">
          <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
            평균가
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">
            {formatEok(data.stats.avgDealAmount)}
          </p>
        </article>
      </section>

      <section className="rounded-2xl border border-slate-200/80 bg-white/85 p-4 shadow-sm sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">거래이력</h2>
          <p className="text-xs text-slate-500">
            국토교통부 실거래가 기준 · 최근 12개월
          </p>
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setAreaKey("all")}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              areaKey === "all"
                ? "bg-slate-900 text-white"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            전체 ({data.stats.totalTradeCount})
          </button>
          {data.areas.map((area) => (
            <button
              key={area.key}
              type="button"
              onClick={() => setAreaKey(area.key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                areaKey === area.key
                  ? "bg-teal-700 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              {area.label} · {area.count}건
            </button>
          ))}
        </div>

        {grouped.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
            선택한 조건의 거래가 없습니다.
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {grouped.map(([year, items]) => (
              <div key={year}>
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <CalendarDays className="h-4 w-4 text-teal-700" />
                  {year}년
                </h3>
                <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200/80 bg-white">
                  {items.map((tx) => (
                    <li
                      key={tx.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3 sm:px-4"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900">
                          {formatDealDate(tx.dealDate).slice(5)}{" "}
                          <span className="font-normal text-slate-500">
                            {tx.exclusiveArea.toFixed(2)}㎡ (
                            {Math.round(toPyeong(tx.exclusiveArea))}평) ·{" "}
                            {tx.floor}층
                          </span>
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {tx.dong} · {tx.dealingGbn || "중개거래"}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {tx.isSingoga ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-rose-500 px-2 py-0.5 text-[11px] font-semibold text-white">
                            <Flame className="h-3 w-3" />
                            신고가
                          </span>
                        ) : null}
                        <p className="text-base font-semibold text-slate-900">
                          {formatEok(tx.dealAmount)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
