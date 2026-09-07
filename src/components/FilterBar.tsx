"use client";

import { useMemo } from "react";
import {
  Building2,
  CalendarDays,
  Search,
  TrendingUp,
} from "lucide-react";
import {
  AREA_OPTIONS,
  DEAL_TYPE_OPTIONS,
  DISTRICT_OPTIONS,
  dongOptionsForDistrict,
} from "@/lib/constants/regions";
import { yearMonthLabel } from "@/lib/utils/format";
import type { AreaFilter, DealType } from "@/types/transaction";

interface FilterBarProps {
  aptName: string;
  gu: string;
  dong: string;
  dealType: DealType | "all";
  area: AreaFilter;
  yearMonth: string;
  yearMonths: string[];
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
  yearMonths,
  onAptNameChange,
  onGuChange,
  onDongChange,
  onDealTypeChange,
  onAreaChange,
  onYearMonthChange,
  onSearch,
}: FilterBarProps) {
  const dongOptions = useMemo(() => dongOptionsForDistrict(gu), [gu]);

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white/90 p-4 shadow-sm backdrop-blur sm:p-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-700">
        <Search className="h-4 w-4 text-teal-600" />
        검색 필터
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-7">
        <label className="flex flex-col gap-1.5 xl:col-span-2">
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

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-500">구</span>
          <select
            value={gu}
            onChange={(e) => onGuChange(e.target.value)}
            className={selectClass}
          >
            {DISTRICT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-500">법정동</span>
          <select
            value={dong}
            onChange={(e) => onDongChange(e.target.value)}
            className={selectClass}
          >
            {dongOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
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

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-slate-500">계약년월</span>
          <div className="relative">
            <CalendarDays className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <select
              value={yearMonth}
              onChange={(e) => onYearMonthChange(e.target.value)}
              className={`${selectClass} pl-10`}
            >
              {yearMonths.map((ym) => (
                <option key={ym} value={ym}>
                  {yearMonthLabel(ym)}
                </option>
              ))}
            </select>
          </div>
        </label>
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onSearch}
          className="inline-flex items-center gap-2 rounded-lg bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-500/40"
        >
          <TrendingUp className="h-4 w-4" />
          조회
        </button>
      </div>
    </section>
  );
}
