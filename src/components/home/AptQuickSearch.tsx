"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { aptDetailHref, type AptSuggestion } from "@/lib/molit/apt-client";
import { formatComplexLocationLabel } from "@/lib/complexes/recent-views";
import { formatEok } from "@/lib/utils/format";
import {
  suggestRegions,
  type RegionSuggestion,
} from "@/lib/region/suggest-regions";

type FlatHit =
  | { kind: "apt"; item: AptSuggestion }
  | { kind: "region"; item: RegionSuggestion };

/** 메인·단지조회·헤더에서 재사용하는 단지(+지역) 자동완성 검색 */
export function AptQuickSearch({
  compact = false,
  inputId = "apt-quick-search",
  placeholder = "아파트 단지 또는 지역을 검색하세요.",
  /** false면 가격 대신 동명 구분용 지역만 강조 */
  showPrice = true,
  /** true면 기존 apt-suggest + 지역 suggestRegions를 함께 표시 */
  includeRegions = false,
  autoFocus = false,
  onNavigate,
  hint,
}: {
  compact?: boolean;
  inputId?: string;
  placeholder?: string;
  showPrice?: boolean;
  includeRegions?: boolean;
  autoFocus?: boolean;
  onNavigate?: () => void;
  hint?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [openSuggest, setOpenSuggest] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query.trim()), 220);
    return () => window.clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!autoFocus) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, [autoFocus]);

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

  const aptSuggestions = useMemo(
    () => suggestQuery.data ?? [],
    [suggestQuery.data],
  );
  const regionSuggestions = useMemo(
    () =>
      includeRegions && debouncedQuery.length >= 1
        ? suggestRegions(debouncedQuery, 6)
        : [],
    [includeRegions, debouncedQuery],
  );

  const flatHits = useMemo<FlatHit[]>(() => {
    const hits: FlatHit[] = [];
    for (const item of regionSuggestions) {
      hits.push({ kind: "region", item });
    }
    for (const item of aptSuggestions) {
      hits.push({ kind: "apt", item });
    }
    return hits;
  }, [aptSuggestions, regionSuggestions]);

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

  const finish = (href: string) => {
    setOpenSuggest(false);
    onNavigate?.();
    router.push(href);
  };

  const goApt = (aptName: string, regionSlug: string, gu?: string) => {
    finish(aptDetailHref(aptName, regionSlug, gu));
  };

  const goRegion = (slug: string) => {
    finish(`/region/${slug}`);
  };

  const activateHit = (hit: FlatHit) => {
    if (hit.kind === "apt") {
      goApt(hit.item.aptName, hit.item.regionSlug, hit.item.gu);
    } else {
      goRegion(hit.item.slug);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (activeIndex >= 0 && flatHits[activeIndex]) {
      activateHit(flatHits[activeIndex]);
      return;
    }
    if (flatHits[0]) activateHit(flatHits[0]);
  };

  const clearQuery = () => {
    setQuery("");
    setDebouncedQuery("");
    setActiveIndex(-1);
    setOpenSuggest(false);
    inputRef.current?.focus();
  };

  const emptyMessage = includeRegions
    ? "일치하는 단지·지역이 없습니다."
    : "일치하는 단지가 없습니다.";

  return (
    <form onSubmit={onSubmit} className={compact ? "w-full" : "max-w-2xl"}>
      <label className="sr-only" htmlFor={inputId}>
        {includeRegions ? "단지 또는 지역 검색" : "단지명 검색"}
      </label>
      <div ref={searchWrapRef} className="relative z-30">
        <div className="relative flex min-h-12 items-center overflow-hidden rounded-xl border border-slate-200 bg-white">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            ref={inputRef}
            id={inputId}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpenSuggest(true);
              setActiveIndex(-1);
            }}
            onFocus={() => setOpenSuggest(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setOpenSuggest(false);
                setActiveIndex(-1);
                return;
              }
              if (!openSuggest || flatHits.length === 0) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((i) =>
                  i < flatHits.length - 1 ? i + 1 : 0,
                );
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((i) =>
                  i > 0 ? i - 1 : flatHits.length - 1,
                );
              }
            }}
            placeholder={placeholder}
            className={`w-full border-0 bg-transparent pl-10 text-sm text-slate-900 outline-none placeholder:text-slate-400 ${
              query.length > 0 ? "pr-10" : "pr-3"
            } ${compact ? "py-2.5" : "py-2.5 sm:py-3"}`}
            autoComplete="off"
          />
          {query.length > 0 ? (
            <button
              type="button"
              aria-label="입력 지우기"
              onClick={clearQuery}
              className="absolute top-1/2 right-2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>

        {openSuggest && debouncedQuery.length >= 1 && (
          <div className="absolute top-full left-0 z-50 mt-1.5 w-full overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-900">
            {suggestQuery.isFetching && flatHits.length === 0 ? (
              <p className="px-4 py-3 text-sm text-slate-500">검색 중…</p>
            ) : flatHits.length === 0 ? (
              <p className="px-4 py-3 text-sm text-slate-500">{emptyMessage}</p>
            ) : includeRegions ? (
              <div className="max-h-80 overflow-y-auto py-1">
                {regionSuggestions.length > 0 ? (
                  <div>
                    <p className="px-4 pt-2 pb-1 text-[11px] font-bold tracking-wide text-slate-400 uppercase">
                      지역
                    </p>
                    <ul>
                      {regionSuggestions.map((item, rIndex) => {
                        const index = rIndex;
                        return (
                          <li key={`region-${item.slug}`}>
                            <button
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => goRegion(item.slug)}
                              className={`flex w-full items-start justify-between gap-3 px-4 py-2.5 text-left transition ${
                                index === activeIndex
                                  ? "bg-teal-50 text-teal-900"
                                  : "hover:bg-slate-50"
                              }`}
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-semibold text-slate-900">
                                  {item.name}
                                </span>
                                <span className="mt-0.5 block truncate text-xs text-slate-500">
                                  {item.metroLabel} · {item.matchLabel}
                                </span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
                {aptSuggestions.length > 0 ? (
                  <div>
                    <p className="px-4 pt-2 pb-1 text-[11px] font-bold tracking-wide text-slate-400 uppercase">
                      단지
                    </p>
                    <ul>
                      {aptSuggestions.map((item, aIndex) => {
                        const index = regionSuggestions.length + aIndex;
                        const location = formatComplexLocationLabel({
                          regionSlug: item.regionSlug,
                          regionName: item.regionName,
                          gu: item.gu,
                          dong: item.dong,
                        });
                        return (
                          <li
                            key={`apt-${item.regionSlug}-${item.aptName}-${item.gu}-${item.dong}`}
                          >
                            <button
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() =>
                                goApt(item.aptName, item.regionSlug, item.gu)
                              }
                              className={`flex w-full items-start justify-between gap-3 px-4 py-2.5 text-left transition ${
                                index === activeIndex
                                  ? "bg-teal-50 text-teal-900"
                                  : "hover:bg-slate-50"
                              }`}
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-semibold text-slate-900">
                                  {item.aptName}
                                </span>
                                <span className="mt-0.5 block truncate text-xs text-slate-500">
                                  {location}
                                </span>
                              </span>
                              {showPrice ? (
                                <span className="shrink-0 text-sm font-semibold text-rose-600">
                                  {formatEok(item.maxDealAmount)}
                                </span>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : (
              <ul className="max-h-80 overflow-y-auto py-1">
                {aptSuggestions.map((item, index) => {
                  const location = formatComplexLocationLabel({
                    regionSlug: item.regionSlug,
                    regionName: item.regionName,
                    gu: item.gu,
                    dong: item.dong,
                  });
                  return (
                    <li
                      key={`${item.regionSlug}-${item.aptName}-${item.gu}-${item.dong}`}
                    >
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() =>
                          goApt(item.aptName, item.regionSlug, item.gu)
                        }
                        className={`flex w-full items-start justify-between gap-3 px-4 py-2.5 text-left transition ${
                          index === activeIndex
                            ? "bg-teal-50"
                            : "hover:bg-slate-50"
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-slate-900">
                            {item.aptName}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-slate-500">
                            {location}
                          </span>
                        </span>
                        {showPrice ? (
                          <span className="shrink-0 text-sm font-semibold text-rose-600">
                            {formatEok(item.maxDealAmount)}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
      {hint ? (
        <p className="mt-1.5 text-xs text-slate-500">{hint}</p>
      ) : null}
    </form>
  );
}
