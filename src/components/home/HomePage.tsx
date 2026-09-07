"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";
import {
  ArrowRight,
  MapPinned,
  Search,
  TrendingUp,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  GYEONGGI_REGIONS,
  SEOUL_REGIONS,
  type RegionDef,
} from "@/lib/constants/regions";
import type { RankItem, RankingsResponse } from "@/lib/molit/rankings";
import { LAWD_TO_REGION } from "@/lib/constants/regions";
import { yearMonthLabel } from "@/lib/utils/format";

async function fetchRankings(): Promise<RankingsResponse> {
  const res = await fetch("/api/rankings");
  if (!res.ok) throw new Error("failed");
  return res.json();
}

function regionHrefForTx(item: RankItem): string {
  const tx = item.transaction;
  // try match by gu containing region name
  const found = Object.values(LAWD_TO_REGION).find((r) => {
    if (r.metro === "seoul") return tx.gu.includes(r.name) || r.name === tx.gu;
    return (
      tx.gu.includes(r.name.replace("시", "").replace("군", "")) ||
      r.districts.some((d) => tx.gu.includes(d.name))
    );
  });
  const slug = found?.slug ?? "seoul-gangnam";
  return `/region/${slug}?aptName=${encodeURIComponent(tx.aptName)}`;
}

function RankCard({
  item,
  accent = "teal",
}: {
  item: RankItem;
  accent?: "teal" | "rose" | "sky";
}) {
  const tx = item.transaction;
  const href = regionHrefForTx(item);
  const priceColor =
    accent === "rose"
      ? "text-rose-600"
      : accent === "sky"
        ? "text-sky-700"
        : "text-teal-700";

  return (
    <Link
      href={href}
      className="group relative flex flex-col rounded-2xl border border-slate-200/90 bg-white p-4 shadow-sm transition hover:border-teal-300 hover:shadow-md"
    >
      <span className="absolute top-3 right-3 inline-flex h-7 w-7 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
        {item.rank}
      </span>
      <p className="pr-10 text-sm font-semibold text-slate-900 group-hover:text-teal-800">
        {tx.aptName}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        {tx.gu} · {tx.dong}
      </p>
      <p className={`mt-3 text-2xl font-semibold tracking-tight ${priceColor}`}>
        {item.priceLabel}
      </p>
      <p className="mt-1 text-xs text-slate-500">{item.metaLabel}</p>
      <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-teal-700">
        지역에서 보기
        <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

function RankSection({
  title,
  dateLabel,
  items,
  accent,
  emptyText,
}: {
  title: string;
  dateLabel: string;
  items: RankItem[];
  accent?: "teal" | "rose" | "sky";
  emptyText: string;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
          <span className="h-5 w-1 rounded-full bg-teal-600" />
          {title}
        </h2>
        <p className="text-xs text-slate-500">{dateLabel}</p>
      </div>
      {items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-300 bg-white/70 px-4 py-8 text-center text-sm text-slate-500">
          {emptyText}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {items.map((item) => (
            <RankCard
              key={`${title}-${item.rank}-${item.transaction.id}`}
              item={item}
              accent={accent}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RegionGrid({
  title,
  regions,
}: {
  title: string;
  regions: RegionDef[];
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
        <span className="h-5 w-1 rounded-full bg-teal-600" />
        {title}
      </h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {regions.map((region) => (
          <Link
            key={region.slug}
            href={`/region/${region.slug}`}
            className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-medium text-slate-800 shadow-sm transition hover:border-teal-300 hover:bg-teal-50/50 hover:text-teal-900"
          >
            {region.name}
          </Link>
        ))}
      </div>
    </section>
  );
}

export function HomePage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [regionQuery, setRegionQuery] = useState("");
  const rankings = useQuery({
    queryKey: ["rankings"],
    queryFn: fetchRankings,
  });

  const filteredSeoul = useMemo(() => {
    const q = regionQuery.trim();
    if (!q) return SEOUL_REGIONS;
    return SEOUL_REGIONS.filter((r) => r.name.includes(q) || r.fullName.includes(q));
  }, [regionQuery]);

  const filteredGyeonggi = useMemo(() => {
    const q = regionQuery.trim();
    if (!q) return GYEONGGI_REGIONS;
    return GYEONGGI_REGIONS.filter(
      (r) => r.name.includes(q) || r.fullName.includes(q),
    );
  }, [regionQuery]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    // 단지 검색은 지역 선택 유도 — 기본 강남으로 이동하되 쿼리 전달
    // 사용자가 지역 디렉터리에서 고르는 게 정확함
    if (!q) {
      document.getElementById("regions")?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    router.push(`/region/seoul-gangnam?aptName=${encodeURIComponent(q)}`);
  };

  const data = rankings.data;
  const ymLabel = data ? yearMonthLabel(data.yearMonth) : "";

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <section className="relative overflow-hidden rounded-3xl border border-teal-900/10 bg-gradient-to-br from-slate-900 via-teal-900 to-slate-800 px-5 py-8 text-white shadow-lg sm:px-8 sm:py-10">
        <div
          className="pointer-events-none absolute inset-0 opacity-35"
          style={{
            backgroundImage:
              "radial-gradient(circle at 15% 20%, rgba(45,212,191,0.35), transparent 42%), radial-gradient(circle at 85% 0%, rgba(56,189,248,0.22), transparent 38%)",
          }}
        />
        <div className="relative">
          <p className="text-sm font-medium tracking-wide text-teal-100/90">
            아파트 실거래
          </p>
          <h1 className="mt-2 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
            서울 · 경기 아파트 실거래가
          </h1>
          <p className="mt-2 max-w-xl text-sm text-teal-50/85 sm:text-base">
            서울 25개 구, 경기 31개 시·군의 매매·전월세 실거래를 지역별로
            조회하세요.
          </p>

          <form onSubmit={onSubmit} className="mt-6 max-w-2xl">
            <label className="sr-only" htmlFor="home-search">
              단지명 검색
            </label>
            <div className="flex overflow-hidden rounded-2xl bg-white shadow-lg ring-1 ring-black/5">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-4 h-5 w-5 -translate-y-1/2 text-slate-400" />
                <input
                  id="home-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="예) 래미안, 헬리오시티, 자이"
                  className="w-full border-0 bg-transparent py-3.5 pr-3 pl-12 text-sm text-slate-900 outline-none placeholder:text-slate-400"
                />
              </div>
              <button
                type="submit"
                className="bg-teal-600 px-5 text-sm font-semibold text-white transition hover:bg-teal-700"
              >
                조회
              </button>
            </div>
            <p className="mt-2 text-xs text-teal-100/70">
              아래에서 구·시를 선택한 뒤 조회하면 더 정확합니다
            </p>
          </form>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <a
          href="#regions-seoul"
          className="inline-flex items-center justify-between gap-3 rounded-2xl bg-gradient-to-r from-teal-600 to-teal-500 px-5 py-4 text-white shadow-sm transition hover:from-teal-700 hover:to-teal-600"
        >
          <span className="inline-flex items-center gap-2 text-sm font-semibold">
            <MapPinned className="h-4 w-4" />
            서울 구별 실거래
          </span>
          <ArrowRight className="h-4 w-4" />
        </a>
        <a
          href="#regions-gyeonggi"
          className="inline-flex items-center justify-between gap-3 rounded-2xl bg-gradient-to-r from-slate-800 to-slate-700 px-5 py-4 text-white shadow-sm transition hover:from-slate-900 hover:to-slate-800"
        >
          <span className="inline-flex items-center gap-2 text-sm font-semibold">
            <MapPinned className="h-4 w-4" />
            경기 시·군별 실거래
          </span>
          <ArrowRight className="h-4 w-4" />
        </a>
      </div>

      {data?.headline && (
        <p className="rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-sm leading-relaxed text-slate-700 shadow-sm">
          <TrendingUp className="mr-1.5 inline h-4 w-4 text-teal-600" />
          {data.headline}
        </p>
      )}

      {rankings.isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-36 animate-pulse rounded-2xl border border-slate-200 bg-white/70"
            />
          ))}
        </div>
      ) : data ? (
        <div className="flex flex-col gap-10">
          <RankSection
            title="매매 최고가 TOP5"
            dateLabel={ymLabel}
            items={data.tradeHigh}
            accent="rose"
            emptyText="매매 최고가 데이터가 없습니다."
          />
          <RankSection
            title="최근 실거래 TOP5"
            dateLabel={ymLabel}
            items={data.recent}
            accent="teal"
            emptyText="최근 거래 데이터가 없습니다."
          />
          <RankSection
            title="전월세 최고가 TOP5"
            dateLabel={ymLabel}
            items={data.rentHigh}
            accent="sky"
            emptyText="전월세 데이터가 없습니다."
          />
        </div>
      ) : null}

      <div id="regions" className="flex flex-col gap-6 scroll-mt-20">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">지역별 조회</h2>
            <p className="mt-1 text-sm text-slate-500">
              서울 25개 구 · 경기 31개 시·군
            </p>
          </div>
          <input
            value={regionQuery}
            onChange={(e) => setRegionQuery(e.target.value)}
            placeholder="지역명 검색 (예: 강남, 분당, 수원)"
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 sm:max-w-xs"
          />
        </div>

        <div id="regions-seoul" className="scroll-mt-24">
          <RegionGrid title="서울특별시" regions={filteredSeoul} />
        </div>
        <div id="regions-gyeonggi" className="scroll-mt-24">
          <RegionGrid title="경기도" regions={filteredGyeonggi} />
        </div>
      </div>

      <footer className="border-t border-slate-200 pt-4 pb-8 text-center text-xs text-slate-400">
        국토교통부 아파트 실거래 OpenAPI 기반 · 아파트 실거래
      </footer>
    </div>
  );
}
