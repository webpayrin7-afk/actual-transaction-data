"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  AlertCircle,
  BarChart3,
  Building2,
  MapPin,
  Search,
} from "lucide-react";
import { FilterBar } from "@/components/FilterBar";
import { Pagination } from "@/components/Pagination";
import { RegionDongBrowse } from "@/components/RegionDongBrowse";
import { StatsCards } from "@/components/StatsCards";
import { TransactionTable } from "@/components/TransactionTable";
import { PAGE_SIZE, type RegionDef } from "@/lib/constants/regions";
import { recentYearMonths, yearMonthLabel } from "@/lib/utils/format";
import { useTransactions } from "@/hooks/useTransactions";
import type { AreaFilter, DealType } from "@/types/transaction";

type RegionTab = "dong" | "stats" | "search";

const TABS: { id: RegionTab; label: string; icon: typeof Building2 }[] = [
  { id: "dong", label: "동별 선택", icon: Building2 },
  { id: "stats", label: "지역 통계", icon: BarChart3 },
  { id: "search", label: "지역 검색", icon: Search },
];

function parseTab(value: string | null | undefined): RegionTab | null {
  if (value === "dong" || value === "stats" || value === "search") return value;
  return null;
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
  const tab =
    parseTab(searchParams.get("tab")) ??
    (initialTab ?? (initialAptName.trim() ? "search" : "dong"));
  const [aptNameInput, setAptNameInput] = useState(initialAptName);
  const [gu, setGu] = useState(initialGu);
  const [dong, setDong] = useState("all");
  const [browseDong, setBrowseDong] = useState<string | null>(null);
  const [browseGu, setBrowseGu] = useState<string | null>(null);
  const [dealType, setDealType] = useState<DealType | "all">(initialDealType);
  const [area, setArea] = useState<AreaFilter>("all");
  const [yearMonth, setYearMonth] = useState(() => yearMonths[0]);
  const [page, setPage] = useState(1);
  const [appliedAptName, setAppliedAptName] = useState(initialAptName);
  const [, startTransition] = useTransition();

  const query = useTransactions(
    {
      aptName: appliedAptName,
      gu,
      dong,
      dealType,
      area,
      yearMonth,
      page,
      pageSize: PAGE_SIZE,
      region: region.slug,
    },
    { enabled: tab === "stats" || tab === "search" },
  );

  const data = query.data;
  const resolvedYearMonth = data?.yearMonth ?? yearMonth;

  const resetPage = () => setPage(1);

  const selectTab = (next: RegionTab) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const handleGuChange = (value: string) => {
    setGu(value);
    setDong("all");
    setBrowseDong(null);
    setBrowseGu(null);
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

  const handleYearMonthChange = (value: string) => {
    setYearMonth(value);
    resetPage();
  };

  const handleSearch = () => {
    startTransition(() => {
      setAppliedAptName(aptNameInput.trim());
      setPage(1);
    });
  };

  const handleBrowseDeals = (selected: string, nextGu: string) => {
    setDong(selected);
    setGu(nextGu);
    setPage(1);
    selectTab("search");
  };

  const handleBrowseDongSelect = (
    nextDong: string | null,
    nextGu: string | null,
  ) => {
    setBrowseDong(nextDong);
    setBrowseGu(nextGu);
  };

  const codesLabel = region.lawdCodes.join(" / ");

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <header className="relative overflow-hidden rounded-3xl border border-teal-900/10 bg-gradient-to-br from-slate-900 via-teal-900 to-slate-800 px-6 py-8 text-white shadow-lg sm:px-8">
        <div
          className="pointer-events-none absolute inset-0 opacity-30"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 20%, rgba(45,212,191,0.35), transparent 40%), radial-gradient(circle at 80% 0%, rgba(125,211,252,0.25), transparent 35%), linear-gradient(135deg, transparent 40%, rgba(15,23,42,0.4))",
          }}
        />
        <div className="relative">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-medium text-teal-100 backdrop-blur">
              <MapPin className="h-3.5 w-3.5" />
              {region.fullName} · {codesLabel}
            </div>
            <Link
              href="/regions"
              className="rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-medium text-teal-100 backdrop-blur transition hover:bg-white/20"
            >
              ← 지역별 조회
            </Link>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            {region.name} 아파트 실거래가
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-teal-50/85 sm:text-base">
            동별 단지 · 지역 통계 · 거래 검색을 한곳에서 확인합니다.
          </p>
          <p className="mt-4 text-xs text-teal-100/70">
            계약년월 {yearMonthLabel(resolvedYearMonth)} · 최근 거래일 기준
            내림차순
          </p>
        </div>
      </header>

      <nav
        className="flex gap-1 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm"
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

      {tab === "dong" && (
        <RegionDongBrowse
          regionSlug={region.slug}
          regionName={region.name}
          yearMonth={yearMonth}
          yearMonths={yearMonths}
          selectedDong={browseDong}
          selectedGu={browseGu}
          onYearMonthChange={handleYearMonthChange}
          onDongSelect={handleBrowseDongSelect}
          onBrowseDeals={handleBrowseDeals}
        />
      )}

      {tab === "stats" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-end sm:justify-between sm:p-5">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">지역 통계</h2>
              <p className="mt-1 text-sm text-slate-500">
                선택한 계약월 기준 {region.name} 매매·전월세 요약입니다.
              </p>
            </div>
            <label className="flex w-full flex-col gap-1.5 sm:max-w-[11rem]">
              <span className="text-xs font-medium text-slate-500">
                기준 계약월
              </span>
              <select
                value={resolvedYearMonth}
                onChange={(e) => handleYearMonthChange(e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20"
              >
                {yearMonths.map((ym) => (
                  <option key={ym} value={ym}>
                    {yearMonthLabel(ym)}
                  </option>
                ))}
              </select>
            </label>
          </div>

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
                통계 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
              </p>
            </div>
          )}

          <StatsCards stats={data?.stats} isLoading={query.isLoading} />
        </div>
      )}

      {tab === "search" && (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
            <h2 className="text-lg font-semibold text-slate-900">지역 검색</h2>
            <p className="mt-1 text-sm text-slate-500">
              구·동·단지명·거래유형으로 실거래 내역을 검색합니다.
            </p>
          </div>

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
            yearMonths={yearMonths}
            districts={region.districts}
            onAptNameChange={setAptNameInput}
            onGuChange={handleGuChange}
            onDongChange={handleDongChange}
            onDealTypeChange={handleDealTypeChange}
            onAreaChange={handleAreaChange}
            onYearMonthChange={handleYearMonthChange}
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
