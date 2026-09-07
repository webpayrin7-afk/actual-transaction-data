"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowRight,
  Search,
  TrendingUp,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { LAWD_TO_REGION } from "@/lib/constants/regions";
import type { RankItem, RankingsResponse } from "@/lib/molit/rankings";
import { aptDetailHref, type AptSuggestion } from "@/lib/molit/apt";
import {
  formatDealDate,
  formatEok,
  yearMonthLabel,
} from "@/lib/utils/format";

async function fetchRankings(): Promise<RankingsResponse> {
  const res = await fetch("/api/rankings");
  if (!res.ok) throw new Error("failed");
  return res.json();
}

function regionHrefForTx(item: RankItem): string {
  const tx = item.transaction;
  const found = Object.values(LAWD_TO_REGION).find((r) => {
    if (r.metro === "seoul") return tx.gu.includes(r.name) || r.name === tx.gu;
    return (
      tx.gu.includes(r.name.replace("시", "").replace("군", "")) ||
      r.districts.some((d) => tx.gu.includes(d.name))
    );
  });
  const slug = found?.slug ?? "seoul-gangnam";
  return aptDetailHref(tx.aptName, slug, tx.gu);
}

function RankCard({
  item,
}: {
  item: RankItem;
}) {
  const tx = item.transaction;
  const href = regionHrefForTx(item);

  return (
    <Link
      href={href}
      className="group relative flex flex-col rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-teal-300 hover:bg-teal-50/50"
    >
      <span className="absolute top-3 right-3 inline-flex h-7 w-7 items-center justify-center rounded-full bg-slate-800 text-xs font-semibold text-white">
        {item.rank}
      </span>
      <p className="pr-10 text-sm font-semibold text-slate-900 group-hover:text-slate-950">
        {tx.aptName}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        {tx.gu} · {tx.dong}
      </p>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-teal-700">
        {item.priceLabel}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">
        {item.metaLabel}
      </p>
      <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-teal-700">
        단지에서 보기
        <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

function sectionDateLabel(items: RankItem[], fallbackYm: string): string {
  if (items.length === 0) {
    return fallbackYm ? yearMonthLabel(fallbackYm) : "";
  }
  const latest = items.reduce((best, cur) =>
    cur.transaction.dealDate > best.transaction.dealDate ? cur : best,
  );
  return formatDealDate(latest.transaction.dealDate);
}

function RankSection({
  title,
  dateLabel,
  items,
  emptyText,
}: {
  title: string;
  dateLabel: string;
  items: RankItem[];
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
        <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
          {emptyText}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {items.map((item) => (
            <RankCard
              key={`${title}-${item.rank}-${item.transaction.id}`}
              item={item}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function ComplexesPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [openSuggest, setOpenSuggest] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchWrapRef = useRef<HTMLDivElement>(null);

  const rankings = useQuery({
    queryKey: ["rankings"],
    queryFn: fetchRankings,
  });

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query.trim()), 220);
    return () => window.clearTimeout(t);
  }, [query]);

  const suggestQuery = useQuery({
    queryKey: ["apt-suggest", debouncedQuery],
    queryFn: async (): Promise<AptSuggestion[]> => {
      const res = await fetch(
        `/api/apt-suggest?q=${encodeURIComponent(debouncedQuery)}`,
      );
      if (!res.ok) return [];
      const json = (await res.json()) as { suggestions?: AptSuggestion[] };
      return json.suggestions ?? [];
    },
    enabled: debouncedQuery.length >= 1,
  });

  const suggestions = suggestQuery.data ?? [];

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!searchWrapRef.current?.contains(event.target as Node)) {
        setOpenSuggest(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  const goApt = (aptName: string, regionSlug: string, gu?: string) => {
    setOpenSuggest(false);
    router.push(aptDetailHref(aptName, regionSlug, gu));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) {
      router.push("/regions");
      return;
    }

    if (activeIndex >= 0 && suggestions[activeIndex]) {
      const hit = suggestions[activeIndex];
      goApt(hit.aptName, hit.regionSlug, hit.gu);
      return;
    }

    if (suggestions[0]) {
      goApt(suggestions[0].aptName, suggestions[0].regionSlug, suggestions[0].gu);
      return;
    }

    // 자동완성 결과가 아직 없으면 즉시 조회
    try {
      const res = await fetch(`/api/apt-suggest?q=${encodeURIComponent(q)}`);
      const json = (await res.json()) as { suggestions?: AptSuggestion[] };
      const hit = json.suggestions?.[0];
      if (hit) {
        goApt(hit.aptName, hit.regionSlug, hit.gu);
        return;
      }
    } catch {
      // fall through
    }

    // 최후: 강남 지역 필터로 이동 (검색어만 전달)
    router.push(`/region/seoul-gangnam?aptName=${encodeURIComponent(q)}`);
  };

  const data = rankings.data;
  const fallbackYm = data?.yearMonth ?? "";
  const singogaItems = data?.singogaTop ?? data?.tradeHigh ?? [];
  const jeonseItems = data?.jeonseTop ?? [];
  const wolseItems = data?.wolseTop ?? [];

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <section className="relative rounded-3xl border border-teal-900/10 bg-gradient-to-br from-slate-900 via-teal-900 to-slate-800 px-5 py-8 text-white shadow-lg sm:px-8 sm:py-10">
        <div
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-3xl opacity-35"
          style={{
            backgroundImage:
              "radial-gradient(circle at 15% 20%, rgba(45,212,191,0.35), transparent 42%), radial-gradient(circle at 85% 0%, rgba(56,189,248,0.22), transparent 38%)",
          }}
        />
        <div className="relative">
          <h1 className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
            단지별 조회
          </h1>
          <p className="mt-2 max-w-xl text-sm text-teal-50/85 sm:text-base">
            아파트 단지명을 검색해 실거래가와 거래 이력을 확인하세요.
          </p>

          <form onSubmit={onSubmit} className="mt-6 max-w-2xl">
            <label className="sr-only" htmlFor="home-search">
              단지명 검색
            </label>
            <div ref={searchWrapRef} className="relative z-30">
              <div className="flex overflow-hidden rounded-2xl bg-white shadow-lg ring-1 ring-black/5">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute top-1/2 left-4 h-5 w-5 -translate-y-1/2 text-slate-400" />
                  <input
                    id="home-search"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setOpenSuggest(true);
                      setActiveIndex(-1);
                    }}
                    onFocus={() => setOpenSuggest(true)}
                    onKeyDown={(e) => {
                      if (!openSuggest || suggestions.length === 0) return;
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setActiveIndex((i) =>
                          i < suggestions.length - 1 ? i + 1 : 0,
                        );
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setActiveIndex((i) =>
                          i > 0 ? i - 1 : suggestions.length - 1,
                        );
                      } else if (e.key === "Escape") {
                        setOpenSuggest(false);
                        setActiveIndex(-1);
                      }
                    }}
                    placeholder="예) 래미안, 헬리오시티, 자이"
                    className="w-full border-0 bg-transparent py-3.5 pr-3 pl-12 text-sm text-slate-900 outline-none placeholder:text-slate-400"
                    autoComplete="off"
                  />
                </div>
                <button
                  type="submit"
                  className="bg-teal-600 px-5 text-sm font-semibold text-white transition hover:bg-teal-700"
                >
                  조회
                </button>
              </div>

              {openSuggest && debouncedQuery.length >= 1 && (
                <div className="absolute top-full left-0 z-50 mt-2 w-full overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-xl">
                  {suggestQuery.isFetching ? (
                    <p className="px-4 py-3 text-sm text-slate-500">검색 중…</p>
                  ) : suggestions.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-slate-500">
                      일치하는 단지가 없습니다. 지역을 골라 조회해 보세요.
                    </p>
                  ) : (
                    <ul className="max-h-80 overflow-y-auto py-1">
                      {suggestions.map((item, index) => (
                        <li key={`${item.regionSlug}-${item.aptName}`}>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => goApt(item.aptName, item.regionSlug, item.gu)}
                            className={`flex w-full items-start justify-between gap-3 px-4 py-2.5 text-left transition ${
                              index === activeIndex
                                ? "bg-teal-50"
                                : "hover:bg-slate-50"
                            }`}
                          >
                            <span>
                              <span className="block text-sm font-semibold text-slate-900">
                                {item.aptName}
                              </span>
                              <span className="mt-0.5 block text-xs text-slate-500">
                                {item.regionName} · {item.dong} · 거래{" "}
                                {item.dealCount}건
                              </span>
                            </span>
                            <span className="shrink-0 text-sm font-semibold text-rose-600">
                              {formatEok(item.maxDealAmount)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <p className="mt-2 text-xs text-teal-100/70">
              예) 래미안, 헬리오시티 — 선택 시 단지 상세로 이동합니다
            </p>
          </form>
        </div>
      </section>

      {data?.headline && (
        <p className="rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-sm leading-relaxed text-slate-700 shadow-sm">
          <TrendingUp className="mr-1.5 inline h-4 w-4 text-teal-600" />
          {data.headline}
        </p>
      )}

      {rankings.isLoading ? (
        <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white p-5 sm:p-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="h-36 animate-pulse rounded-2xl border border-slate-200 bg-slate-50"
              />
            ))}
          </div>
        </div>
      ) : data ? (
        <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white p-5 sm:p-6">
          <div className="flex flex-col gap-8">
            <RankSection
              title="아파트 신고가 TOP5"
              dateLabel={sectionDateLabel(singogaItems, fallbackYm)}
              items={singogaItems}
              emptyText="아파트 신고가 데이터가 없습니다."
            />
            <div className="h-px bg-slate-200" />
            <RankSection
              title="아파트 전세 TOP5"
              dateLabel={sectionDateLabel(jeonseItems, fallbackYm)}
              items={jeonseItems}
              emptyText="아파트 전세 데이터가 없습니다."
            />
            <div className="h-px bg-slate-200" />
            <RankSection
              title="아파트 월세 TOP5"
              dateLabel={sectionDateLabel(wolseItems, fallbackYm)}
              items={wolseItems}
              emptyText="아파트 월세 데이터가 없습니다."
            />
          </div>
        </div>
      ) : null}

      <footer className="border-t border-slate-200 pt-4 pb-8 text-center text-xs text-slate-400">
        국토교통부 아파트 실거래 OpenAPI 기반 · 아파트 데이터랩
      </footer>
    </div>
  );
}
