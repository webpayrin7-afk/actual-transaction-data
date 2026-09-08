"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  BarChart3,
  Building2,
  Search,
} from "lucide-react";
import { FilterBar } from "@/components/FilterBar";
import { Pagination } from "@/components/Pagination";
import { RegionDailyStatus } from "@/components/RegionDailyStatus";
import { RegionDongBrowse } from "@/components/RegionDongBrowse";
import { TransactionTable } from "@/components/TransactionTable";
import { BackLink } from "@/components/layout/BackLink";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { PAGE_SIZE, type RegionDef } from "@/lib/constants/regions";
import { recentYearMonths } from "@/lib/utils/format";
import { useTransactions } from "@/hooks/useTransactions";
import type { AreaFilter, DealType } from "@/types/transaction";

type RegionTab = "dong" | "stats" | "search";

/** 지역 요약 → 실거래 → 단지 탐색 */
const TABS: { id: RegionTab; label: string; icon: typeof Building2 }[] = [
  { id: "stats", label: "시장 현황", icon: BarChart3 },
  { id: "search", label: "실거래", icon: Search },
  { id: "dong", label: "단지 탐색", icon: Building2 },
];

function parseTab(value: string | null | undefined): RegionTab | null {
  if (value === "dong" || value === "stats" || value === "search") return value;
  return null;
}

async function fetchRegionCoverage(region: string): Promise<string[]> {
  const res = await fetch(
    `/api/region-coverage?region=${encodeURIComponent(region)}`,
  );
  if (!res.ok) throw new Error("Failed to fetch region coverage");
  const data = (await res.json()) as { yearMonths?: string[] };
  return Array.isArray(data.yearMonths) ? data.yearMonths : [];
}

export function Dashboard({
  region,
  initialAptName = "",
  initialGu = "all",
  initialDealType = "all",
  initialTab,
}: {
  region: RegionDef;
  initialAptName?: string;
  initialGu?: string;
  initialDealType?: DealType | "all";
  initialTab?: RegionTab;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const yearMonths = useMemo(() => recentYearMonths(6), []);
  const currentYearMonth = yearMonths[0];
  const tab =
    parseTab(searchParams.get("tab")) ??
    (initialTab ?? (initialAptName.trim() ? "search" : "stats"));
  const [aptNameInput, setAptNameInput] = useState(initialAptName);
  const [gu, setGu] = useState(initialGu);
  const [dong, setDong] = useState("all");
  const [dealType, setDealType] = useState<DealType | "all">(initialDealType);
  const [area, setArea] = useState<AreaFilter>("all");
  const [searchYearMonth, setSearchYearMonth] = useState(() => currentYearMonth);
  const [statsYearMonth, setStatsYearMonth] = useState(() => currentYearMonth);
  const [page, setPage] = useState(1);
  const [appliedAptName, setAppliedAptName] = useState(initialAptName);
  const [, startTransition] = useTransition();

  const coverageQuery = useQuery({
    queryKey: ["region-coverage", region.slug],
    queryFn: () => fetchRegionCoverage(region.slug),
    enabled: tab === "search",
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const availableYearMonths = coverageQuery.data?.length
    ? coverageQuery.data
    : yearMonths;

  const query = useTransactions(
    {
      aptName: appliedAptName,
      gu,
      dong,
      dealType,
      area,
      yearMonth: searchYearMonth,
      page,
      pageSize: PAGE_SIZE,
      region: region.slug,
    },
    { enabled: tab === "search" },
  );

  const data = query.data;
  const resolvedYearMonth = data?.yearMonth ?? searchYearMonth;

  const resetPage = () => setPage(1);

  const resetTabFilters = () => {
    setAptNameInput("");
    setAppliedAptName("");
    setGu(initialGu);
    setDong("all");
    setDealType(initialDealType);
    setArea("all");
    setSearchYearMonth(currentYearMonth);
    setStatsYearMonth(currentYearMonth);
    setPage(1);
  };

  const selectTab = (next: RegionTab) => {
    if (next === tab) return;
    resetTabFilters();
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const handleGuChange = (value: string) => {
    setGu(value);
    setDong("all");
    resetPage();
  };

  const handleDongChange = (value: string) => {
    setDong(value);
    resetPage();
  };

  const handleDealTypeChange = (value: DealType | "all") => {
    setDealType(value);
    resetPage();
  };

  const handleAreaChange = (value: AreaFilter) => {
    setArea(value);
    resetPage();
  };

  const handleSearchYearMonthChange = (value: string) => {
    setSearchYearMonth(value);
    resetPage();
  };

  const handleStatsYearMonthChange = (value: string) => {
    setStatsYearMonth(value);
  };

  const handleSearch = () => {
    startTransition(() => {
      setAppliedAptName(aptNameInput.trim());
      setPage(1);
    });
  };

  return (
    <div className={PAGE_SHELL}>
      <div className="mb-2">
        <BackLink fallback="/regions" />
      </div>
      <PageHeader
        title={`${region.name} 아파트 시장`}
        description={`${region.fullName} 실거래·신고가·단지 현황을 확인하세요.`}
      />

      <nav
        className="inline-flex w-full gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-0.5 sm:w-auto"
        aria-label="지역 상세 탭"
      >
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => selectTab(id)}
              aria-pressed={active}
              className={`flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-medium transition sm:flex-none sm:text-[13px] ${
                active
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </nav>

      {tab === "dong" && <RegionDongBrowse regionSlug={region.slug} />}

      {tab === "stats" && (
        <RegionDailyStatus
          regionSlug={region.slug}
          yearMonth={statsYearMonth}
          yearMonths={yearMonths}
          onYearMonthChange={handleStatsYearMonthChange}
        />
      )}

      {tab === "search" && (
        <div className="flex flex-col gap-4">
          {(data?.warning || data?.source === "mock") && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                {data?.warning ? (
                  data.warning
                ) : (
                  <>
                    <span className="font-semibold">데모 데이터</span>로 표시
                    중입니다. `MOLIT_API_KEY`를 설정하면 해당 지역 실시간
                    실거래가가 조회됩니다.
                  </>
                )}
              </p>
            </div>
          )}

          {query.isError && (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                거래 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
              </p>
            </div>
          )}

          <FilterBar
            aptName={aptNameInput}
            gu={gu}
            dong={dong}
            dealType={dealType}
            area={area}
            yearMonth={resolvedYearMonth}
            availableYearMonths={availableYearMonths}
            districts={region.districts}
            onAptNameChange={setAptNameInput}
            onGuChange={handleGuChange}
            onDongChange={handleDongChange}
            onDealTypeChange={handleDealTypeChange}
            onAreaChange={handleAreaChange}
            onYearMonthChange={handleSearchYearMonthChange}
            onSearch={handleSearch}
          />

          <section className="flex flex-col gap-3">
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                거래 내역
              </h3>
              <p className="mt-0.5 text-xs text-slate-500">
                계약일 · 단지 · 면적 · 가격 · 층 — 단지명 클릭 시 상세로 이동
              </p>
            </div>

            <TransactionTable
              items={data?.items ?? []}
              isLoading={query.isLoading || query.isFetching}
            />

            {data && data.totalCount > 0 && (
              <Pagination
                page={data.page}
                totalPages={data.totalPages}
                totalCount={data.totalCount}
                onPageChange={setPage}
              />
            )}
          </section>
        </div>
      )}

      <footer className="border-t border-slate-200 pt-4 text-center text-xs text-slate-400">
        데이터 출처: 국토교통부 아파트매매/전월세 실거래 OpenAPI ·{" "}
        {region.fullName}
      </footer>
    </div>
  );
}
