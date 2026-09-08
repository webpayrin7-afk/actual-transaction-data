"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ALL_REGIONS,
  METRO_LABELS,
  type Metro,
  type RegionDef,
} from "@/lib/constants/regions";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";

const METRO_OPTIONS = (
  Object.entries(METRO_LABELS) as [Metro, string][]
).filter(([k]) => k !== "other");

type RegionSuggestion = {
  slug: string;
  name: string;
  fullName: string;
  metroLabel: string;
  matchLabel: string;
  score: number;
};

function normalize(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

function scoreRegion(query: string, region: RegionDef): RegionSuggestion | null {
  const q = normalize(query);
  if (!q) return null;

  const candidates: Array<{ label: string; weight: number }> = [
    { label: region.name, weight: 100 },
    { label: region.fullName, weight: 80 },
    ...region.districts.map((d) => ({ label: d.name, weight: 70 })),
  ];

  let best: RegionSuggestion | null = null;
  for (const candidate of candidates) {
    const key = normalize(candidate.label);
    let score = 0;
    if (key === q) score = 1000 + candidate.weight;
    else if (key.startsWith(q)) score = 500 + candidate.weight + q.length;
    else if (key.includes(q)) score = 200 + candidate.weight + q.length;
    else continue;

    const next: RegionSuggestion = {
      slug: region.slug,
      name: region.name,
      fullName: region.fullName,
      metroLabel: METRO_LABELS[region.metro] ?? region.metro,
      matchLabel:
        candidate.label === region.name ? region.fullName : candidate.label,
      score,
    };
    if (!best || next.score > best.score) best = next;
  }
  return best;
}

function suggestRegions(query: string, limit = 8): RegionSuggestion[] {
  const q = query.trim();
  if (!q) return [];

  const ranked = ALL_REGIONS.map((region) => scoreRegion(q, region))
    .filter((v): v is RegionSuggestion => Boolean(v))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ko"));

  const seen = new Set<string>();
  const unique: RegionSuggestion[] = [];
  for (const item of ranked) {
    if (seen.has(item.slug)) continue;
    seen.add(item.slug);
    unique.push(item);
    if (unique.length >= limit) break;
  }
  return unique;
}

/**
 * 지역 조회 인덱스.
 * 시·도 → 시·군·구 compact selector 후 /region/[slug]로 이동.
 * 시장 KPI/랭킹은 지역 상세에서 확인 (여기선 선택만).
 */
export function RegionsPage() {
  const router = useRouter();
  const [metro, setMetro] = useState<Metro>(() => {
    if (typeof window === "undefined") return "seoul";
    const hash = window.location.hash.replace("#", "") as Metro;
    return METRO_OPTIONS.some(([k]) => k === hash) ? hash : "seoul";
  });
  const [regionQuery, setRegionQuery] = useState("");
  const [openSuggest, setOpenSuggest] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchWrapRef = useRef<HTMLDivElement>(null);

  const regions = useMemo(
    () => ALL_REGIONS.filter((r) => r.metro === metro),
    [metro],
  );

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

  const suggestions = useMemo(
    () => suggestRegions(regionQuery, 8),
    [regionQuery],
  );

  const goRegion = (slug: string) => {
    setOpenSuggest(false);
    setActiveIndex(-1);
    router.push(`/region/${slug}`);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (activeIndex >= 0 && suggestions[activeIndex]) {
      goRegion(suggestions[activeIndex].slug);
      return;
    }
    if (suggestions[0]) goRegion(suggestions[0].slug);
  };

  return (
    <div className={PAGE_SHELL}>
      <PageHeader
        title="지역 조회"
        description="지역별 아파트 실거래와 시장 현황을 확인하세요."
      >
        <form onSubmit={onSubmit} className="relative z-30 max-w-xl">
          <label className="sr-only" htmlFor="region-search">
            지역명 검색
          </label>
          <div ref={searchWrapRef} className="relative z-30">
            <input
              id="region-search"
              value={regionQuery}
              onChange={(e) => {
                setRegionQuery(e.target.value);
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
              placeholder="지역명 검색 (예: 강남, 분당, 수원)"
              className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-teal-400 focus:ring-2 focus:ring-teal-100"
              autoComplete="off"
            />

            {openSuggest && regionQuery.trim().length >= 1 && (
              <div className="absolute top-full right-0 left-0 z-50 mt-1.5 overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-900 shadow-lg">
                {suggestions.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-slate-500">
                    일치하는 지역이 없습니다.
                  </p>
                ) : (
                  <ul className="max-h-72 overflow-y-auto py-1">
                    {suggestions.map((item, index) => (
                      <li key={item.slug}>
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => goRegion(item.slug)}
                          className={`flex w-full items-start justify-between gap-3 px-4 py-2.5 text-left transition ${
                            index === activeIndex
                              ? "bg-teal-50"
                              : "hover:bg-slate-50"
                          }`}
                        >
                          <span>
                            <span className="block text-sm font-semibold text-slate-900">
                              {item.name}
                            </span>
                            <span className="mt-0.5 block text-xs text-slate-500">
                              {item.metroLabel} · {item.matchLabel}
                            </span>
                          </span>
                          <span className="shrink-0 text-xs font-medium text-teal-700">
                            이동
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </form>
      </PageHeader>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900 sm:text-lg">
            지역 선택
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 sm:text-sm">
            시·도를 고른 뒤 시·군·구를 선택하면 해당 지역 시장으로 이동합니다
          </p>
        </div>

        {/* 시·도 — nationwide METRO_OPTIONS */}
        <div className="flex flex-wrap gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
          {METRO_OPTIONS.map(([value, label]) => {
            const active = metro === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setMetro(value)}
                className={`min-h-8 rounded-md px-2.5 text-xs font-medium transition sm:px-3 sm:text-[13px] ${
                  active
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* 시·군·구 */}
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
          {regions.map((region) => (
            <Link
              key={region.slug}
              href={`/region/${region.slug}`}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-center text-xs font-medium text-slate-800 transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-900 sm:text-sm"
            >
              {region.name}
            </Link>
          ))}
        </div>
      </section>

      <footer className="border-t border-slate-200 pt-4 text-center text-xs text-slate-400">
        국토교통부 아파트 실거래 OpenAPI 기반 · 아파트 데이터랩
      </footer>
    </div>
  );
}
