"use client";

import { useMemo, useState, useTransition } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { FilterBar } from "@/components/FilterBar";
import { Pagination } from "@/components/Pagination";
import { TransactionTable } from "@/components/TransactionTable";
import { useLoadProgressWhen } from "@/components/layout/LoadProgress";
import { LAB_SECTION_SURFACE, LabSectionHeader } from "@/components/ui/LabSection";
import { PAGE_SIZE, type RegionDef } from "@/lib/constants/regions";
import { recentYearMonths } from "@/lib/utils/format";
import { useTransactions } from "@/hooks/useTransactions";
import type { AreaFilter, DealType } from "@/types/transaction";

async function fetchRegionCoverage(region: string): Promise<string[]> {
  const res = await fetch(`/api/region-coverage?region=${encodeURIComponent(region)}`);
  if (!res.ok) throw new Error("Failed to fetch region coverage");
  const data = (await res.json()) as { yearMonths?: string[] };
  return Array.isArray(data.yearMonths) ? data.yearMonths : [];
}

/** 한 지역 안에서 조건으로 실거래를 조회한다 (필터 + 결과 표 + 페이지). */
export function RegionTransactionSearch({
  region,
  initialAptName = "",
  initialGu = "all",
  initialDealType = "all",
}: {
  region: RegionDef;
  initialAptName?: string;
  initialGu?: string;
  initialDealType?: DealType | "all";
}) {
  const yearMonths = useMemo(() => recentYearMonths(6), []);
  const [aptNameInput, setAptNameInput] = useState(initialAptName);
  const [gu, setGu] = useState(initialGu);
  const [dong, setDong] = useState("all");
  const [dealType, setDealType] = useState<DealType | "all">(initialDealType);
  const [area, setArea] = useState<AreaFilter>("all");
  const [searchYearMonth, setSearchYearMonth] = useState(() => yearMonths[0]);
  const [page, setPage] = useState(1);
  const [appliedAptName, setAppliedAptName] = useState(initialAptName);
  const [, startTransition] = useTransition();

  const coverageQuery = useQuery({
    queryKey: ["region-coverage", region.slug],
    queryFn: () => fetchRegionCoverage(region.slug),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const availableYearMonths = coverageQuery.data?.length ? coverageQuery.data : yearMonths;

  const query = useTransactions({
    aptName: appliedAptName,
    gu,
    dong,
    dealType,
    area,
    yearMonth: searchYearMonth,
    page,
    pageSize: PAGE_SIZE,
    region: region.slug,
  });
  const data = query.data;
  const resolvedYearMonth = data?.yearMonth ?? searchYearMonth;
  useLoadProgressWhen(query.isLoading && !data, "거래 내역 불러오는 중…");

  const resetPage = () => setPage(1);

  return (
    <div className="flex flex-col gap-4">
      {(data?.warning || data?.source === "mock") && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {data?.warning ? (
              data.warning
            ) : (
              <>
                <span className="font-semibold">데모 데이터</span>로 표시 중입니다.
              </>
            )}
          </p>
        </div>
      )}

      {query.isError && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>거래 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>
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
        onGuChange={(value) => {
          setGu(value);
          setDong("all");
          resetPage();
        }}
        onDongChange={(value) => {
          setDong(value);
          resetPage();
        }}
        onDealTypeChange={(value) => {
          setDealType(value);
          resetPage();
        }}
        onAreaChange={(value) => {
          setArea(value);
          resetPage();
        }}
        onYearMonthChange={(value) => {
          setSearchYearMonth(value);
          resetPage();
        }}
        onSearch={() => {
          startTransition(() => {
            setAppliedAptName(aptNameInput.trim());
            setPage(1);
          });
        }}
      />

      <section
        aria-label={`${region.name} 거래 내역`}
        className={`${LAB_SECTION_SURFACE} flex flex-col gap-3`}
      >
        <LabSectionHeader
          title="거래 내역"
          meta={
            data && data.totalCount > 0
              ? `${data.totalCount.toLocaleString("ko-KR")}건 · 계약일 기준`
              : "계약일 기준"
          }
          tip={<p>단지명을 누르면 단지 상세로 이동합니다.</p>}
        />
        <TransactionTable
          items={data?.items ?? []}
          isLoading={query.isLoading || query.isFetching}
          regionSlug={region.slug}
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
  );
}
