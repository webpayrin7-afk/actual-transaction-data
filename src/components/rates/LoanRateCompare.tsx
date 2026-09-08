"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownUp, ArrowUpDown, ExternalLink, RefreshCw } from "lucide-react";
import type { BankLoanRate, DreamMoneyResult } from "@/lib/seoul/dream-money";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";

type FilterMode = "all" | "first";
type SortKey =
  | "minRate"
  | "maxRate"
  | "avgRate"
  | "avgSubsidyRate"
  | "loanCount"
  | "orgName";

function formatRate(n: number): string {
  return n.toFixed(2);
}

function formatCount(n: number): string {
  return n.toLocaleString("ko-KR");
}

async function loadRates(): Promise<DreamMoneyResult> {
  const res = await fetch("/api/loan-rates");
  const data = (await res.json()) as DreamMoneyResult & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || "금리 데이터를 불러오지 못했습니다.");
  }
  return data;
}

function SortButton({
  label,
  active,
  asc,
  onClick,
}: {
  label: string;
  active: boolean;
  asc: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 whitespace-nowrap ${
        active ? "font-semibold text-teal-800" : "font-medium text-slate-500"
      }`}
    >
      {label}
      {active ? (
        <ArrowDownUp className={`h-3.5 w-3.5 ${asc ? "" : "rotate-180"}`} />
      ) : (
        <ArrowUpDown className="h-3.5 w-3.5 opacity-40" />
      )}
    </button>
  );
}

export function LoanRateCompare() {
  const [filter, setFilter] = useState<FilterMode>("all");
  const [sortKey, setSortKey] = useState<SortKey>("minRate");
  const [sortAsc, setSortAsc] = useState(true);

  const query = useQuery({
    queryKey: ["loan-rates"],
    queryFn: loadRates,
    staleTime: 60 * 60 * 1000,
  });

  const rows = useMemo(() => {
    const items = query.data?.items ?? [];
    const filtered =
      filter === "first" ? items.filter((r) => r.isFirstTier) : items;

    const sorted = [...filtered].sort((a, b) => {
      const dir = sortAsc ? 1 : -1;
      if (sortKey === "orgName") {
        return a.orgName.localeCompare(b.orgName, "ko") * dir;
      }
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === bv) return a.orgName.localeCompare(b.orgName, "ko");
      return (av < bv ? -1 : 1) * dir;
    });
    return sorted;
  }, [query.data?.items, filter, sortKey, sortAsc]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortAsc((v) => !v);
      return;
    }
    setSortKey(key);
    setSortAsc(true);
  }

  const periodLabel = useMemo(() => {
    const first = query.data?.items?.[0];
    if (!first) return null;
    return `${first.periodStart} ~ ${first.periodEnd}`;
  }, [query.data?.items]);

  const lowest = rows[0] ?? null;

  return (
    <div className={PAGE_SHELL}>
      <PageHeader
        title="금리비교"
        description="서울시 시중은행협력자금 취급 은행별 최근 3개월 실행 금리(대출·보전)를 비교합니다. 최저금리 순으로 한눈에 볼 수 있습니다."
        meta={
          periodLabel ? (
            <span>기준기간 {periodLabel}</span>
          ) : undefined
        }
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${query.isFetching ? "animate-spin" : ""}`}
              />
              새로고침
            </button>
            <Link
              href="/loan"
              className="text-xs font-medium text-teal-700 hover:underline"
            >
              대출계산기
            </Link>
          </div>
        }
      />

      <div className="flex flex-wrap gap-2">
        {(
          [
            { value: "all", label: "전체" },
            { value: "first", label: "1금융만" },
          ] as const
        ).map((opt) => {
          const active = filter === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setFilter(opt.value)}
              className={`rounded-lg px-3.5 py-2 text-sm font-medium transition ${
                active
                  ? "bg-teal-700 text-white"
                  : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {query.isLoading ? (
        <div className="border-y border-slate-200 bg-white px-1 py-16 text-center text-sm text-slate-500 sm:border sm:rounded-2xl sm:px-5">
          금리 정보를 불러오는 중…
        </div>
      ) : null}

      {query.isError ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-5 py-8 text-sm text-rose-800">
          {(query.error as Error).message}
          <p className="mt-2 text-rose-600">
            Vercel/로컬 환경변수{" "}
            <code className="rounded bg-white/70 px-1">SEOUL_OPENAPI_KEY</code>
            에 서울 열린데이터광장 인증키가 설정돼 있는지 확인해 주세요.
          </p>
        </div>
      ) : null}

      {query.data ? (
        <>
          {query.data.usingSampleKey || query.data.partial ? (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              현재 샘플 키로 {query.data.items.length}건만 표시 중입니다 (전체{" "}
              {query.data.totalCount}건). Vercel 환경변수{" "}
              <code className="rounded bg-white/70 px-1">SEOUL_OPENAPI_KEY</code>
              를 저장한 뒤 재배포하면 전체 은행이 표시됩니다.
            </p>
          ) : null}

          {lowest ? (
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-slate-200 pb-4 text-sm text-slate-600">
              <span>
                <span className="text-slate-500">비교 </span>
                <span className="font-semibold text-slate-900">
                  {rows.length}
                </span>
                개 기관
              </span>
              <span>
                <span className="text-slate-500">최저 </span>
                <span className="font-semibold tabular-nums text-teal-800">
                  {formatRate(lowest.minRate)}%
                </span>
                <span className="text-slate-500"> · {lowest.orgName}</span>
              </span>
            </div>
          ) : null}

          {/* Mobile list */}
          <ul className="flex flex-col divide-y divide-slate-100 border-y border-slate-200 bg-white sm:hidden">
            {rows.length === 0 ? (
              <li className="px-1 py-12 text-center text-sm text-slate-500">
                표시할 금리 데이터가 없습니다.
              </li>
            ) : (
              rows.map((row, index) => (
                <MobileRateRow
                  key={row.orgCode || row.orgName}
                  row={row}
                  rank={index + 1}
                />
              ))
            )}
          </ul>

          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-2xl border border-slate-200 bg-white sm:block">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">
                    <SortButton
                      label="기관"
                      active={sortKey === "orgName"}
                      asc={sortAsc}
                      onClick={() => toggleSort("orgName")}
                    />
                  </th>
                  <th className="px-4 py-3">구분</th>
                  <th className="px-4 py-3 text-right">
                    <span className="inline-flex w-full justify-end">
                      <SortButton
                        label="취급건수"
                        active={sortKey === "loanCount"}
                        asc={sortAsc}
                        onClick={() => toggleSort("loanCount")}
                      />
                    </span>
                  </th>
                  <th className="px-4 py-3 text-right">
                    <span className="inline-flex w-full justify-end">
                      <SortButton
                        label="최저(%)"
                        active={sortKey === "minRate"}
                        asc={sortAsc}
                        onClick={() => toggleSort("minRate")}
                      />
                    </span>
                  </th>
                  <th className="px-4 py-3 text-right">
                    <span className="inline-flex w-full justify-end">
                      <SortButton
                        label="최고(%)"
                        active={sortKey === "maxRate"}
                        asc={sortAsc}
                        onClick={() => toggleSort("maxRate")}
                      />
                    </span>
                  </th>
                  <th className="px-4 py-3 text-right">
                    <span className="inline-flex w-full justify-end">
                      <SortButton
                        label="평균(%)"
                        active={sortKey === "avgRate"}
                        asc={sortAsc}
                        onClick={() => toggleSort("avgRate")}
                      />
                    </span>
                  </th>
                  <th className="px-4 py-3 text-right">
                    <span className="inline-flex w-full justify-end">
                      <SortButton
                        label="보전평균(%)"
                        active={sortKey === "avgSubsidyRate"}
                        asc={sortAsc}
                        onClick={() => toggleSort("avgSubsidyRate")}
                      />
                    </span>
                  </th>
                  <th className="px-4 py-3 text-right">계산</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-4 py-12 text-center text-slate-500"
                    >
                      표시할 금리 데이터가 없습니다.
                    </td>
                  </tr>
                ) : (
                  rows.map((row, index) => (
                    <DesktopRateRow
                      key={row.orgCode || row.orgName}
                      row={row}
                      rank={index + 1}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          <p className="text-xs leading-5 text-slate-500">
            출처:{" "}
            <a
              href="https://data.seoul.go.kr/dataList/OA-21098/A/1/datasetView.do"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-teal-700 hover:underline"
            >
              서울시 은행별 대출금리(시중은행협력자금) OA-21098
              <ExternalLink className="h-3 w-3" />
            </a>
            . 중소기업육성자금·시중은행협력자금 실행 금리이며, 주택담보대출
            공시금리와는 다를 수 있습니다.
            {query.data.fetchedAt
              ? ` (갱신 ${new Date(query.data.fetchedAt).toLocaleString("ko-KR")})`
              : null}
          </p>
        </>
      ) : null}
    </div>
  );
}

function MobileRateRow({ row, rank }: { row: BankLoanRate; rank: number }) {
  const lowest = rank === 1;
  return (
    <li className={`px-1 py-3.5 ${lowest ? "bg-teal-50/50" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {lowest ? (
              <span className="rounded bg-teal-700 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                최저
              </span>
            ) : (
              <span className="text-xs text-slate-400">{rank}</span>
            )}
            <span className="font-medium text-slate-900">{row.orgName}</span>
            <span className="text-xs text-slate-500">
              {row.isFirstTier ? "1금융" : "기타"}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            취급 {formatCount(row.loanCount)}건 · 보전평균{" "}
            {formatRate(row.avgSubsidyRate)}%
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-lg font-semibold tabular-nums text-teal-800">
            {formatRate(row.minRate)}
            <span className="text-sm font-medium">%</span>
          </p>
          <p className="text-[11px] tabular-nums text-slate-500">
            평균 {formatRate(row.avgRate)}% · 최고 {formatRate(row.maxRate)}%
          </p>
          <Link
            href={`/loan?rate=${encodeURIComponent(String(row.minRate))}`}
            className="mt-1 inline-block text-xs font-semibold text-teal-700 hover:underline"
          >
            한도계산
          </Link>
        </div>
      </div>
    </li>
  );
}

function DesktopRateRow({ row, rank }: { row: BankLoanRate; rank: number }) {
  const lowest = rank === 1;
  return (
    <tr
      className={`border-b border-slate-100 last:border-0 ${
        lowest ? "bg-teal-50/60" : "hover:bg-slate-50/80"
      }`}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {lowest ? (
            <span className="rounded bg-teal-700 px-1.5 py-0.5 text-[10px] font-semibold text-white">
              최저
            </span>
          ) : (
            <span className="w-5 text-xs text-slate-400">{rank}</span>
          )}
          <span className="font-medium text-slate-900">{row.orgName}</span>
        </div>
      </td>
      <td className="px-4 py-3 text-slate-600">
        {row.isFirstTier ? "1금융" : "기타"}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-slate-700">
        {formatCount(row.loanCount)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums font-semibold text-teal-800">
        {formatRate(row.minRate)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-slate-700">
        {formatRate(row.maxRate)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-slate-700">
        {formatRate(row.avgRate)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-slate-600">
        {formatRate(row.avgSubsidyRate)}
      </td>
      <td className="px-4 py-3 text-right">
        <Link
          href={`/loan?rate=${encodeURIComponent(String(row.minRate))}`}
          className="text-xs font-semibold text-teal-700 hover:underline"
        >
          한도계산
        </Link>
      </td>
    </tr>
  );
}
