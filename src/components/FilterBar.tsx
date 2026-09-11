"use client";

import { useMemo } from "react";
import {
  Building2,
  Search,
  TrendingUp,
} from "lucide-react";
import {
  AREA_OPTIONS,
  DEAL_TYPE_OPTIONS,
  type DistrictUnit,
} from "@/lib/constants/regions";
import type { AreaFilter, DealType } from "@/types/transaction";

interface FilterBarProps {
  aptName: string;
  gu: string;
  dong: string;
  dealType: DealType | "all";
  area: AreaFilter;
  yearMonth: string;
  availableYearMonths: string[];
  districts: DistrictUnit[];
  onAptNameChange: (value: string) => void;
  onGuChange: (value: string) => void;
  onDongChange: (value: string) => void;
  onDealTypeChange: (value: DealType | "all") => void;
  onAreaChange: (value: AreaFilter) => void;
  onYearMonthChange: (value: string) => void;
  onSearch: () => void;
}

const selectClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20";

export function FilterBar({
  aptName,
  gu,
  dong,
  dealType,
  area,
  yearMonth,
  availableYearMonths,
  districts,
  onAptNameChange,
  onGuChange,
  onDongChange,
  onDealTypeChange,
  onAreaChange,
  onYearMonthChange,
  onSearch,
}: FilterBarProps) {
  const showDistrict = districts.length > 1;
  const selectedYear = yearMonth.slice(0, 4);
  const selectedMonth = yearMonth.slice(4, 6);

  const years = useMemo(() => {
    const set = new Set(
      availableYearMonths
        .filter((ym) => /^\d{6}$/.test(ym))
        .map((ym) => ym.slice(0, 4)),
    );
    if (selectedYear) set.add(selectedYear);
    return [...set].sort((a, b) => b.localeCompare(a));
  }, [availableYearMonths, selectedYear]);

  const monthsForYear = useMemo(() => {
    const months = availableYearMonths
      .filter((ym) => ym.startsWith(selectedYear))
      .map((ym) => ym.slice(4, 6));
    const set = new Set(months);
    if (selectedMonth) set.add(selectedMonth);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [availableYearMonths, selectedYear, selectedMonth]);

  function handleYearChange(nextYear: string) {
    const months = availableYearMonths
      .filter((ym) => ym.startsWith(nextYear))
      .map((ym) => ym.slice(4, 6))
      .sort((a, b) => a.localeCompare(b));
    const nextMonth = months.includes(selectedMonth)
      ? selectedMonth
      : (months[months.length - 1] ?? months[0] ?? "01");
    onYearMonthChange(`${nextYear}${nextMonth}`);
  }

  function handleMonthChange(nextMonth: string) {
    onYearMonthChange(`${selectedYear}${nextMonth}`);
  }

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white/90 p-4 shadow-sm backdrop-blur sm:p-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-700">
        <Search className="h-4 w-4 text-teal-600" />
        검색 필터
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-6">
        <label
          className={`flex flex-col gap-1.5 ${showDistrict ? "xl:col-span-1" : "xl:col-span-2"}`}
        >
          <span className="text-xs font-medium text-slate-500">단지명</span>
          <div className="relative">
            <Building2 className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={aptName}
              onChange={(e) => onAptNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSearch();
              }}
              placeholder="예: 래미안, 자이, 푸르지오"
              className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pr-3 pl-10 text-sm text-slate-800 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20"
            />
          </div>
        </label>

        {showDistrict && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-slate-500">구</span>
            <select
              value={gu}
              onChange={(e) => onGuChange(e.target.value)}
              className={selectClass}
            >
              <option value="all">전체 구</option>
              {districts.map((d) => (
                <option key={d.code} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-500">법정동</span>
          <input
            type="text"
            value={dong === "all" ? "" : dong}
            onChange={(e) => onDongChange(e.target.value.trim() || "all")}
            placeholder="예: 역삼동"
            className={selectClass}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-500">거래 유형</span>
          <select
            value={dealType}
            onChange={(e) =>
              onDealTypeChange(e.target.value as DealType | "all")
            }
            className={selectClass}
          >
            {DEAL_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-500">전용면적</span>
          <select
            value={area}
            onChange={(e) => onAreaChange(e.target.value as AreaFilter)}
            className={selectClass}
          >
            {AREA_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-500">계약년월</span>
          <div className="grid grid-cols-2 gap-2">
            <label className="sr-only" htmlFor="filter-contract-year">
              계약년
            </label>
            <select
              id="filter-contract-year"
              value={selectedYear}
              onChange={(e) => handleYearChange(e.target.value)}
              className={selectClass}
            >
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}년
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="filter-contract-month">
              계약월
            </label>
            <select
              id="filter-contract-month"
              value={selectedMonth}
              onChange={(e) => handleMonthChange(e.target.value)}
              className={selectClass}
            >
              {monthsForYear.map((month) => (
                <option key={month} value={month}>
                  {Number(month)}월
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onSearch}
          className="lab-button lab-button-primary gap-2 px-4"

        >
          <TrendingUp className="h-4 w-4" />
          조회
        </button>
      </div>
    </section>
  );
}
