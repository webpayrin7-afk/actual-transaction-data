"use client";

import { BackLink } from "@/components/layout/BackLink";
import { LabDataLoading } from "@/components/ui/LabLoading";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import { RankCircle } from "@/components/ui/RankCircle";
import Link from "next/link";
import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDownUp, ArrowUpDown, ExternalLink, RefreshCw, RotateCcw } from "lucide-react";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import {
  COLLATERAL_LABEL,
  DEFAULT_LOAN_RATE_FILTERS,
  FSS_SOURCE_LABEL,
  FSS_SOURCE_URL,
  LOAN_KIND_LABEL,
  RATE_TYPE_LABEL,
  REPAY_LABEL,
  SECTOR_LABEL,
  loanRateQueryString,
  type LoanRateFilters,
  type LoanRateOption,
  type LoanRateSort,
  type LoanRatesResponse,
} from "@/lib/rates/loan-rate-model";

const COLS = 7;

function formatRate(n: number | null): string {
  return n == null ? "—" : n.toFixed(2);
}

function formatMonth(ym: string | null | undefined): string | null {
  if (!ym) return null;
  const [y, m] = ym.split("-");
  return y && m ? `${y}년 ${Number(m)}월` : ym;
}

/** 서버가 답한 오류 — 다시 시도해도 같은 답이므로 자동 재시도하지 않는다 */
class LoanRatesHttpError extends Error {}

async function loadRates(filters: LoanRateFilters): Promise<LoanRatesResponse> {
  let res: Response;
  try {
    res = await fetch(`/api/loan-rates?${loanRateQueryString(filters)}`);
  } catch {
    throw new Error("네트워크 연결을 확인해 주세요.");
  }
  let data: (LoanRatesResponse & { error?: string }) | null = null;
  try {
    data = (await res.json()) as LoanRatesResponse & { error?: string };
  } catch {
    data = null;
  }
  if (!res.ok || !data || !Array.isArray(data.items)) {
    throw new LoanRatesHttpError(data?.error || `금리 데이터를 불러오지 못했습니다. (${res.status})`);
  }
  return data;
}

type ChoiceOption<T extends string> = { value: T; label: string };

function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly ChoiceOption<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={label}>
      <span className="detail-label w-16 shrink-0">{label}</span>
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={`lab-choice min-h-11! ${active ? "lab-choice-selected" : ""}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function SortButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex min-h-11 items-center gap-1 whitespace-nowrap ${
        active ? "font-semibold text-[color:var(--lab-navy-950)]" : "font-medium text-[color:var(--lab-muted)]"
      }`}
    >
      {label}
      {active ? <ArrowDownUp className="h-3.5 w-3.5" /> : <ArrowUpDown className="h-3.5 w-3.5 opacity-40" />}
    </button>
  );
}

function withAll<T extends string>(labels: Record<T, string>): ChoiceOption<T | "all">[] {
  return [
    { value: "all", label: "전체" },
    ...(Object.entries(labels) as [T, string][]).map(([value, label]) => ({ value, label })),
  ];
}

const KIND_OPTIONS = (Object.entries(LOAN_KIND_LABEL) as [LoanRateFilters["kind"], string][]).map(
  ([value, label]) => ({ value, label }),
);
const SECTOR_OPTIONS = withAll(SECTOR_LABEL);
const RATE_TYPE_OPTIONS = withAll(RATE_TYPE_LABEL);
const REPAY_OPTIONS = withAll(REPAY_LABEL);
const COLLATERAL_OPTIONS = withAll(COLLATERAL_LABEL);

export function LoanRateCompare() {
  const [filters, setFilters] = useState<LoanRateFilters>(DEFAULT_LOAN_RATE_FILTERS);
  const [expanded, setExpanded] = useState(false);

  const query = useQuery({
    queryKey: ["loan-rates", filters],
    queryFn: () => loadRates(filters),
    staleTime: 60 * 60 * 1000,
    placeholderData: keepPreviousData,
    // 서버 오류(4xx/5xx)는 곧바로 오류 화면으로. 재시도는 탭이 가려져 있으면 멈춰서
    // 로딩 표시만 끝없이 남던 문제가 있었다 — 네트워크 끊김만 한 번 더 시도한다.
    retry: (count, error) => !(error instanceof LoanRatesHttpError) && count < 1,
  });

  function update<K extends keyof LoanRateFilters>(key: K, value: LoanRateFilters[K]) {
    setExpanded(false);
    setFilters((f) => ({
      ...f,
      [key]: value,
      // 담보유형은 주택담보대출에만 있다
      ...(key === "kind" && value !== "mortgage" ? { collateral: "all" as const } : {}),
    }));
  }

  const data = query.data;
  const items = data?.items ?? [];
  const visible = expanded ? items : items.slice(0, LAB_LIST_PREVIEW);
  const monthLabel = formatMonth(data?.dclsMonth);

  const setSort = (s: LoanRateSort) => update("sort", s);

  // 표 머리(정렬 단추)는 데이터와 무관 — 불러오는 동안에도 그대로 그린다
  const tableHead = (
    <thead className="border-b border-[color:var(--lab-border)] bg-white text-[13px] leading-5 text-[color:var(--lab-muted)]">
      <tr>
        <th className="px-4 py-3">금융기관 · 상품</th>
        <th className="px-4 py-3">구분</th>
        <th className="px-4 py-3">조건</th>
        <th className="px-4 py-3 text-right">
          <span className="inline-flex w-full justify-end">
            <SortButton label="최저(%)" active={filters.sort === "min"} onClick={() => setSort("min")} />
          </span>
        </th>
        <th className="px-4 py-3 text-right">최고(%)</th>
        <th className="px-4 py-3 text-right">
          <span className="inline-flex w-full justify-end">
            <SortButton label="평균(%)" active={filters.sort === "avg"} onClick={() => setSort("avg")} />
          </span>
        </th>
        <th className="px-4 py-3 text-right">계산</th>
      </tr>
    </thead>
  );

  const errorBox = (message: string) => (
    <div
      role="alert"
      className="rounded-[var(--lab-radius-md)] border border-rose-200 bg-rose-50 px-5 py-6 text-sm text-rose-800"
    >
      <p className="font-semibold">금리 정보를 불러오지 못했습니다.</p>
      <p className="mt-1 text-rose-700">{message}</p>
      <button
        type="button"
        onClick={() => void query.refetch()}
        disabled={query.isFetching}
        className="lab-button lab-button-secondary mt-3 disabled:opacity-50"
      >
        <RotateCcw className={`h-3.5 w-3.5 ${query.isFetching ? "animate-spin" : ""}`} />
        다시 시도
      </button>
    </div>
  );

  return (
    <div className={PAGE_SHELL}>
      <PageHeader
        leading={<BackLink fallback="/tools" compact hideLabel />}
        title="금리비교"
        titleClassName="detail-page-title"
        description="금융감독원 금융상품통합비교공시의 은행·저축은행 주택담보대출과 전세자금대출 금리를 비교합니다. 조건을 고르면 금리가 낮은 상품부터 보여 줍니다."
      />

      <div className="space-y-2">
        <ChoiceGroup label="대출 종류" value={filters.kind} options={KIND_OPTIONS} onChange={(v) => update("kind", v)} />
        <ChoiceGroup label="금융권" value={filters.sector} options={SECTOR_OPTIONS} onChange={(v) => update("sector", v)} />
        <ChoiceGroup
          label="금리유형"
          value={filters.rateType}
          options={RATE_TYPE_OPTIONS}
          onChange={(v) => update("rateType", v)}
        />
        <ChoiceGroup label="상환방식" value={filters.repay} options={REPAY_OPTIONS} onChange={(v) => update("repay", v)} />
        {filters.kind === "mortgage" ? (
          <ChoiceGroup
            label="담보유형"
            value={filters.collateral}
            options={COLLATERAL_OPTIONS}
            onChange={(v) => update("collateral", v)}
          />
        ) : null}
      </div>

      <div className="detail-meta flex flex-wrap items-center gap-x-3 gap-y-1">
        {monthLabel ? <span>공시 기준 {monthLabel}</span> : null}
        {data ? (
          <span className="tabular-nums">
            조건에 맞는 {data.matched.toLocaleString("ko-KR")}개 중 금리 낮은 {items.length}개
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className="lab-button lab-button-secondary ml-auto disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${query.isFetching ? "animate-spin" : ""}`} />
          새로고침
        </button>
        <Link
          href="/loan"
          className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-[color:var(--lab-teal-700)] hover:underline"
        >
          대출계산기
        </Link>
      </div>

      {query.isPending ? (
        <div className="overflow-x-auto rounded-[var(--lab-radius-md)] border border-[color:var(--lab-border)] bg-white">
          <table className="min-w-full text-left text-sm">
            {tableHead}
            <tbody>
              <tr>
                <td colSpan={COLS}>
                  <LabDataLoading label="금리 불러오는 중" minHeight={240} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : query.isError && (!data || query.isPlaceholderData) ? (
        errorBox((query.error as Error).message)
      ) : data ? (
        <>
          {query.isError ? errorBox((query.error as Error).message) : null}
          <div
            className={`overflow-x-auto rounded-[var(--lab-radius-md)] border border-[color:var(--lab-border)] bg-white transition-opacity ${
              query.isPlaceholderData ? "opacity-60" : ""
            }`}
            aria-busy={query.isFetching}
          >
            <table className="min-w-full text-left text-sm">
              {tableHead}
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={COLS} className="px-4 py-12 text-center text-[color:var(--lab-muted)]">
                      선택한 조건에 맞는 공시 상품이 없습니다.
                    </td>
                  </tr>
                ) : (
                  visible.map((row, index) => (
                    <RateRow key={row.id} row={row} rank={index + 1} sort={filters.sort} />
                  ))
                )}
              </tbody>
            </table>
          </div>
          {items.length > LAB_LIST_PREVIEW ? (
            <LabMoreButton
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
              label={`${items.length - LAB_LIST_PREVIEW}개 더보기`}
            />
          ) : null}

          <p className="detail-meta">
            출처:{" "}
            <a
              href={FSS_SOURCE_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-teal-700 hover:underline"
            >
              {FSS_SOURCE_LABEL}
              <ExternalLink className="h-3 w-3" />
            </a>
            {monthLabel ? ` (${monthLabel} 공시)` : ""}. 공시 금리는 전월 취급 실적 기준이며, 실제 금리는 신용도·거래
            조건에 따라 다릅니다.
          </p>
        </>
      ) : null}
    </div>
  );
}

function conditionLabel(row: LoanRateOption): string {
  return [
    row.rateType ? RATE_TYPE_LABEL[row.rateType] : null,
    row.repay ? REPAY_LABEL[row.repay] : null,
    row.collateral ? COLLATERAL_LABEL[row.collateral] : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function RateRow({ row, rank, sort }: { row: LoanRateOption; rank: number; sort: LoanRateSort }) {
  const lowest = rank === 1;
  const calcRate = sort === "min" ? (row.min ?? row.avg) : (row.avg ?? row.min);
  return (
    <tr
      className={`border-b border-[color:var(--lab-border)] last:border-0 ${lowest ? "" : "hover:bg-slate-50/80"}`}
      data-rate-row
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {lowest ? (
            <span className="rounded border border-[color:var(--lab-brand-border)] bg-[color:var(--lab-brand-subtle)] px-1.5 text-xs leading-5 font-semibold text-[color:var(--lab-teal-700)]">
              최저
            </span>
          ) : (
            <RankCircle rank={rank} />
          )}
          <div className="min-w-0">
            <p className="font-semibold text-[color:var(--lab-navy-950)]">{row.bank}</p>
            <p className="detail-meta truncate">{row.product}</p>
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-[color:var(--lab-navy-900)]">{SECTOR_LABEL[row.sector]}</td>
      <td className="whitespace-nowrap px-4 py-3 text-[color:var(--lab-navy-900)]">{conditionLabel(row) || "—"}</td>
      <td
        className={`px-4 py-3 text-right tabular-nums ${
          sort === "min" ? "font-semibold text-[color:var(--lab-navy-950)]" : "text-[color:var(--lab-navy-900)]"
        }`}
      >
        {formatRate(row.min)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-[color:var(--lab-navy-900)]">{formatRate(row.max)}</td>
      <td
        className={`px-4 py-3 text-right tabular-nums ${
          sort === "avg" ? "font-semibold text-[color:var(--lab-navy-950)]" : "text-[color:var(--lab-navy-900)]"
        }`}
      >
        {formatRate(row.avg)}
      </td>
      <td className="px-4 py-3 text-right">
        {calcRate != null ? (
          <Link
            href={`/loan?rate=${encodeURIComponent(String(calcRate))}`}
            className="inline-flex min-h-11 items-center text-sm font-semibold whitespace-nowrap text-[color:var(--lab-teal-700)] hover:underline"
          >
            한도계산
          </Link>
        ) : null}
      </td>
    </tr>
  );
}
