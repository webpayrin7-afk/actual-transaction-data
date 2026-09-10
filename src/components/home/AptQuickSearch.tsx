"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { aptDetailHref, type AptSuggestion } from "@/lib/molit/apt";
import { formatComplexLocationLabel } from "@/lib/complexes/recent-views";
import { formatEok } from "@/lib/utils/format";

/** 메인·단지조회에서 재사용하는 단지 자동완성 검색 */
export function AptQuickSearch({
  compact = false,
  inputId = "apt-quick-search",
  placeholder = "아파트 단지명을 검색하세요",
  emptySubmitHref = "/complexes",
  /** false면 가격 대신 동명 구분용 지역만 강조 */
  showPrice = true,
  hint,
}: {
  compact?: boolean;
  inputId?: string;
  placeholder?: string;
  emptySubmitHref?: string;
  showPrice?: boolean;
  hint?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [openSuggest, setOpenSuggest] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchWrapRef = useRef<HTMLDivElement>(null);

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
      router.push(emptySubmitHref);
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

    router.push(emptySubmitHref);
  };

  return (
    <form onSubmit={onSubmit} className={compact ? "w-full" : "max-w-2xl"}>
      <label className="sr-only" htmlFor={inputId}>
        단지명 검색
      </label>
      <div ref={searchWrapRef} className="relative z-30">
        <div className="flex min-h-12 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)] focus-within:border-teal-500 focus-within:ring-2 focus-within:ring-teal-100">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              id={inputId}
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
              placeholder={placeholder}
              className={`w-full border-0 bg-transparent pr-3 pl-10 text-sm text-slate-900 outline-none placeholder:text-slate-400 ${
                compact ? "py-2.5" : "py-2.5 sm:py-3"
              }`}
              autoComplete="off"
            />
          </div>
          <button
            type="submit"
            className="bg-teal-600 px-4 text-sm font-semibold text-white transition hover:bg-teal-700"
          >
            검색
          </button>
        </div>

        {openSuggest && debouncedQuery.length >= 1 && (
          <div className="absolute top-full left-0 z-50 mt-1.5 w-full overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-900 shadow-lg">
            {suggestQuery.isFetching ? (
              <p className="px-4 py-3 text-sm text-slate-500">검색 중…</p>
            ) : suggestions.length === 0 ? (
              <p className="px-4 py-3 text-sm text-slate-500">
                일치하는 단지가 없습니다. 아래에서 지역으로 찾아보세요.
              </p>
            ) : (
              <ul className="max-h-80 overflow-y-auto py-1">
                {suggestions.map((item, index) => {
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
