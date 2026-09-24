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
} from "@/lib/constants/regions";
import { suggestRegions } from "@/lib/region/suggest-regions";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { Search } from "lucide-react";
import { LabSection, LabSubsectionHeader } from "@/components/ui/LabSection";
import { LabTabs } from "@/components/ui/LabTabs";

/** 지역별 조회 시·도 탭 — 서울 다음 경기(수도권)를 우선 배치 */
const METRO_TAB_ORDER: Metro[] = [
  "seoul",
  "gyeonggi",
  "incheon",
  "busan",
  "daegu",
  "gwangju",
  "daejeon",
  "ulsan",
  "sejong",
  "gangwon",
  "chungbuk",
  "chungnam",
  "jeonbuk",
  "jeonnam",
  "gyeongbuk",
  "gyeongnam",
  "jeju",
];

const METRO_OPTIONS = METRO_TAB_ORDER.filter(
  (key) => key !== "other" && key in METRO_LABELS,
).map((key) => [key, METRO_LABELS[key]] as [Metro, string]);

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
        titleClassName="detail-page-title"
        showDivider={false}
      >
        <form onSubmit={onSubmit} className="relative z-30 max-w-xl">
          <label className="sr-only" htmlFor="region-search">
            지역명 검색
          </label>
          <div ref={searchWrapRef} className="relative z-30">
            <Search className="pointer-events-none absolute top-1/2 left-3 z-10 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
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
              className="lab-input pr-3 pl-10 outline-none placeholder:text-slate-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
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
                            <span className="detail-data-value-emphasis block">
                              {item.name}
                            </span>
                            <span className="detail-meta mt-0.5 block">
                              {item.metroLabel} · {item.matchLabel}
                            </span>
                          </span>
                          <span className="shrink-0 text-[13px] font-medium leading-5 text-[color:var(--lab-teal-700)]">
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

      <LabSection
        title="지역 선택"
      >
        <LabTabs
          variant="secondary"
          ariaLabel="시·도"
          columns={6}
          items={METRO_OPTIONS.map(([id, label]) => ({ id, label }))}
          value={metro}
          onChange={setMetro}
        />

        <div className="flex flex-col gap-3">
          <LabSubsectionHeader
            title={METRO_LABELS[metro]}
            meta={`${regions.length.toLocaleString("ko-KR")}곳`}
          />
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
            {regions.map((region) => (
              <Link
                key={region.slug}
                href={`/region/${region.slug}`}
                className="flex min-h-12 items-center rounded-xl border border-[color:var(--lab-border)] bg-white px-3 py-2.5 transition hover:border-[color:var(--lab-brand-border)] hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                <span className="detail-data-value-emphasis break-keep">{region.name}</span>
              </Link>
            ))}
          </div>
        </div>
      </LabSection>
    </div>
  );
}
