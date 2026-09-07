"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { aptDetailHref, type AptSuggestion } from "@/lib/molit/apt";
import { formatEok } from "@/lib/utils/format";

/** 메인·단지조회에서 재사용하는 단지 자동완성 검색 */
export function AptQuickSearch({
  compact = false,
  inputId = "apt-quick-search",
}: {
  compact?: boolean;
  inputId?: string;
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
      router.push("/complexes");
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

    router.push(`/complexes`);
  };

  return (
    <form onSubmit={onSubmit} className={compact ? "w-full" : "max-w-2xl"}>
      <label className="sr-only" htmlFor={inputId}>
        단지명 검색
      </label>
      <div ref={searchWrapRef} className="relative z-20">
        <div className="flex overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-400" />
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
              placeholder="단지명으로 바로 이동 (예: 래미안)"
              className={`w-full border-0 bg-transparent pr-3 pl-10 text-sm text-slate-900 outline-none placeholder:text-slate-400 ${
                compact ? "py-2.5" : "py-3"
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
          <div className="absolute top-full left-0 z-50 mt-2 w-full overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-xl">
            {suggestQuery.isFetching ? (
              <p className="px-4 py-3 text-sm text-slate-500">검색 중…</p>
            ) : suggestions.length === 0 ? (
              <p className="px-4 py-3 text-sm text-slate-500">
                일치하는 단지가 없습니다.
              </p>
            ) : (
              <ul className="max-h-72 overflow-y-auto py-1">
                {suggestions.map((item, index) => (
                  <li key={`${item.regionSlug}-${item.aptName}-${item.gu}`}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => goApt(item.aptName, item.regionSlug, item.gu)}
                      className={`flex w-full items-start justify-between gap-3 px-4 py-2.5 text-left transition ${
                        index === activeIndex ? "bg-teal-50" : "hover:bg-slate-50"
                      }`}
                    >
                      <span>
                        <span className="block text-sm font-semibold text-slate-900">
                          {item.aptName}
                        </span>
                        <span className="mt-0.5 block text-xs text-slate-500">
                          {item.regionName} · {item.dong}
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
    </form>
  );
}
