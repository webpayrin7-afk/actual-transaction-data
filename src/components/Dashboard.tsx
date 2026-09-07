"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  BarChart3,
  Building2,
  MapPin,
  Search,
} from "lucide-react";
import { FilterBar } from "@/components/FilterBar";
import { Pagination } from "@/components/Pagination";
import { RegionDailyStatus } from "@/components/RegionDailyStatus";
import { RegionDongBrowse } from "@/components/RegionDongBrowse";
import { TransactionTable } from "@/components/TransactionTable";
import { PAGE_SIZE, type RegionDef } from "@/lib/constants/regions";
import { recentYearMonths } from "@/lib/utils/format";
import { useTransactions } from "@/hooks/useTransactions";
import type { AreaFilter, DealType } from "@/types/transaction";

type RegionTab = "dong" | "stats" | "search";

const TABS: { id: RegionTab; label: string; icon: typeof Building2 }[] = [
  { id: "stats", label: "신고가 현황", icon: BarChart3 },
  { id: "dong", label: "동별 상세", icon: Building2 },
  { id: "search", label: "지역 검색", icon: Search },
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
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
      <header className="relative overflow-hidden rounded-2xl border border-teal-900/10 bg-gradient-to-br from-slate-900 via-teal-900 to-slate-800 px-4 py-4 text-white shadow-sm sm:px-5 sm:py-4">
        <div
          className="pointer-events-none absolute inset-0 opacity-25"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 20%, rgba(45,212,191,0.3), transparent 40%), radial-gradient(circle at 80% 0%, rgba(125,211,252,0.2), transparent 35%)",
          }}
        />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-2.5 py-0.5 text-[11px] font-medium text-teal-100 backdrop-blur">
                <MapPin className="h-3 w-3" />
                {region.fullName}
              </div>
              <Link
                href="/regions"
                className="rounded-full border border-white/15 bg-white/10 px-2.5 py-0.5 text-[11px] font-medium text-teal-100 backdrop-blur transition hover:bg-white/20"
              >
                ← 지역별 조회
              </Link>
            </div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
              {region.name} 아파트 실거래가
            </h1>
          </div>
        </div>
      </header>

      <nav
        className="flex gap-1 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm"
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
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                active
                  ? "bg-teal-700 text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
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

          <section className="flex flex-col gap-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">
                  거래 내역
                </h3>
                <p className="hidden text-sm text-slate-500 sm:block">
                  계약일자 · 단지명 · 구 · 법정동 · 전용면적 · 거래금액 · 층수
                </p>
                <p className="text-sm text-slate-500 sm:hidden">
                  금액 · 단지 · 위치 · 면적/층을 한눈에 확인
                </p>
              </div>
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

      <footer className="border-t border-slate-200 pt-4 pb-8 text-center text-xs text-slate-400">
        데이터 출처: 국토교통부 아파트매매/전월세 실거래 OpenAPI ·{" "}
        {region.fullName}
      </footer>
    </div>
  );
}
