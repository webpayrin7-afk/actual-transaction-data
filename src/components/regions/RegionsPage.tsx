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
  GYEONGGI_REGIONS,
  SEOUL_REGIONS,
  type RegionDef,
} from "@/lib/constants/regions";

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
      metroLabel: region.metro === "seoul" ? "서울" : "경기",
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
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm font-medium text-slate-800 transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-900"
          >
            {region.name}
          </Link>
        ))}
      </div>
    </section>
  );
}

export function RegionsPage() {
  const router = useRouter();
  const [regionQuery, setRegionQuery] = useState("");
  const [openSuggest, setOpenSuggest] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const hash = window.location.hash.replace("#", "");
    if (!hash) return;
    const el = document.getElementById(hash);
    if (!el) return;
    window.setTimeout(() => {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }, []);

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
    if (suggestions[0]) {
      goRegion(suggestions[0].slug);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <section className="relative rounded-3xl border border-teal-900/10 bg-gradient-to-br from-slate-900 via-teal-900 to-slate-800 px-5 py-7 text-white shadow-lg sm:px-8">
        <div
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-3xl opacity-35"
          style={{
            backgroundImage:
              "radial-gradient(circle at 15% 20%, rgba(45,212,191,0.35), transparent 42%), radial-gradient(circle at 85% 0%, rgba(56,189,248,0.22), transparent 38%)",
          }}
        />
        <div className="relative">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            지역별 조회
          </h1>
          <p className="mt-2 max-w-xl text-sm text-teal-50/85 sm:text-base">
            지역명을 검색하거나 아래에서 시·군·구를 선택하세요.
          </p>

          <form onSubmit={onSubmit} className="relative z-30 mt-6 max-w-xl">
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
                className="w-full rounded-2xl border-0 bg-white px-4 py-3.5 text-sm text-slate-900 shadow-lg outline-none ring-1 ring-black/5 placeholder:text-slate-400 focus:ring-2 focus:ring-teal-300"
                autoComplete="off"
              />

              {openSuggest && regionQuery.trim().length >= 1 && (
                <div className="absolute top-full right-0 left-0 z-50 mt-2 overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-xl">
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
        </div>
      </section>

      <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-8">
          <div id="seoul" className="scroll-mt-24">
            <RegionGrid title="서울특별시" regions={SEOUL_REGIONS} />
          </div>
          <div id="gyeonggi" className="scroll-mt-24">
            <RegionGrid title="경기도" regions={GYEONGGI_REGIONS} />
          </div>
        </div>
      </div>

      <footer className="border-t border-slate-200 pt-4 pb-8 text-center text-xs text-slate-400">
        국토교통부 아파트 실거래 OpenAPI 기반 · 아파트 데이터랩
      </footer>
    </div>
  );
}
