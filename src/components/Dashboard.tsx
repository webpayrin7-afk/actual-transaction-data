"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertCircle, MapPin } from "lucide-react";
import { FilterBar } from "@/components/FilterBar";
import { Pagination } from "@/components/Pagination";
import { StatsCards } from "@/components/StatsCards";
import { TransactionTable } from "@/components/TransactionTable";
import {
  PAGE_SIZE,
  REGION_DETAIL,
  REGION_LABEL,
} from "@/lib/constants/regions";
import { recentYearMonths, yearMonthLabel } from "@/lib/utils/format";
import { useTransactions } from "@/hooks/useTransactions";
import type { AreaFilter, DealType } from "@/types/transaction";

export function Dashboard() {
  const yearMonths = useMemo(() => recentYearMonths(6), []);
  const [aptNameInput, setAptNameInput] = useState("");
  const [gu, setGu] = useState("all");
  const [dong, setDong] = useState("all");
  const [dealType, setDealType] = useState<DealType | "all">("all");
  const [area, setArea] = useState<AreaFilter>("all");
  const [yearMonth, setYearMonth] = useState(yearMonths[0]);
  const [page, setPage] = useState(1);
  const [appliedAptName, setAppliedAptName] = useState("");
  const [, startTransition] = useTransition();

  const query = useTransactions({
    aptName: appliedAptName,
    gu,
    dong,
    dealType,
    area,
    yearMonth,
    page,
    pageSize: PAGE_SIZE,
  });

  const resetPage = () => setPage(1);

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

  const data = query.data;

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
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-medium text-teal-100 backdrop-blur">
            <MapPin className="h-3.5 w-3.5" />
            {REGION_LABEL} · {REGION_DETAIL} · 41171 / 41173
          </div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            안양시 아파트 실거래가
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-teal-50/85 sm:text-base">
            국토교통부 아파트 매매·전월세 실거래 자료를 기반으로 {REGION_LABEL}{" "}
            {REGION_DETAIL} 전역 일별 거래 동향을 조회합니다.
          </p>
          <p className="mt-4 text-xs text-teal-100/70">
            계약년월 {yearMonthLabel(yearMonth)} · 최근 거래일 기준 내림차순
          </p>
        </div>
      </header>

      {data?.source === "mock" && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <span className="font-semibold">데모 데이터</span>로 표시 중입니다.
            `.env.local`에 `MOLIT_API_KEY`를 설정하면 공공데이터포털에서 안양시
            만안구·동안구 실시간 실거래가가 조회됩니다.
          </p>
        </div>
      )}

      {query.isError && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>거래 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>
        </div>
      )}

      <StatsCards stats={data?.stats} isLoading={query.isLoading} />

      <FilterBar
        aptName={aptNameInput}
        gu={gu}
        dong={dong}
        dealType={dealType}
        area={area}
        yearMonth={yearMonth}
        yearMonths={yearMonths}
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
            <h2 className="text-lg font-semibold text-slate-900">거래 내역</h2>
            <p className="text-sm text-slate-500">
              계약일자 · 단지명 · 구 · 법정동 · 전용면적 · 거래금액 · 층수
            </p>
          </div>
        </div>

        <TransactionTable
          items={data?.items ?? []}
          isLoading={query.isLoading}
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

      <footer className="border-t border-slate-200 pt-4 pb-8 text-center text-xs text-slate-400">
        데이터 출처: 국토교통부 아파트매매/전월세 실거래가 상세자료 OpenAPI ·
        안양시 만안구(41171) · 동안구(41173)
      </footer>
    </div>
  );
}
