"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import type { BankLoanRate, DreamMoneyResult } from "@/lib/seoul/dream-money";

type Filter = "first" | "all";
type SortKey = "min" | "avg" | "name";

const DATASET_URL =
  "https://data.seoul.go.kr/dataList/OA-21098/A/1/datasetView.do";

async function loadRates(): Promise<DreamMoneyResult> {
  const res = await fetch("/api/loan-rates");
  const data = (await res.json()) as DreamMoneyResult & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || "금리 데이터를 불러오지 못했습니다.");
  }
  return data;
}

function formatPct(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}

function RateCard({ row }: { row: BankLoanRate }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-slate-900">
            {row.orgName}
          </h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {row.periodStart} ~ {row.periodEnd}
            {row.loanCount > 0
              ? ` · ${row.loanCount.toLocaleString("ko-KR")}건`
              : ""}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
          {row.isFirstTier ? "1금융" : "기타"}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-slate-50 px-1 py-2">
          <dt className="text-[10px] text-slate-500">최저</dt>
          <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-900">
            {formatPct(row.minRate)}
          </dd>
        </div>
        <div className="rounded-lg bg-slate-50 px-1 py-2">
          <dt className="text-[10px] text-slate-500">평균</dt>
          <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-900">
            {formatPct(row.avgRate)}
          </dd>
        </div>
        <div className="rounded-lg bg-slate-50 px-1 py-2">
          <dt className="text-[10px] text-slate-500">최고</dt>
          <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-900">
            {formatPct(row.maxRate)}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-[11px] text-slate-500">
        이자보전 평균 {formatPct(row.avgSubsidyRate)}
        {row.minSubsidyRate || row.maxSubsidyRate
          ? ` (최저 ${formatPct(row.minSubsidyRate)} · 최고 ${formatPct(row.maxSubsidyRate)})`
          : ""}
      </p>
    </article>
  );
}

export function LoanRatesPanel({
  heading = "h2",
}: {
  heading?: "h1" | "h2";
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<SortKey>("min");

  const q = useQuery({
    queryKey: ["loan-rates"],
    queryFn: loadRates,
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });

  const rows = useMemo(() => {
    const list = q.data?.items ?? [];
    const filtered = filter === "first" ? list.filter((r) => r.isFirstTier) : list;
    return [...filtered].sort((a, b) => {
      if (sort === "name") return a.orgName.localeCompare(b.orgName, "ko");
      const av = sort === "min" ? a.minRate : a.avgRate;
      const bv = sort === "min" ? b.minRate : b.avgRate;
      if (av === bv) return a.orgName.localeCompare(b.orgName, "ko");
      return av - bv;
    });
  }, [q.data, filter, sort]);

  const periodLabel = useMemo(() => {
    const list = q.data?.items ?? [];
    if (!list.length) return null;
    const starts = list.map((r) => r.periodStart).filter(Boolean).sort();
    const ends = list.map((r) => r.periodEnd).filter(Boolean).sort();
    if (!starts.length || !ends.length) return null;
    const start = starts[0];
    const end = ends[ends.length - 1];
    return start === end ? start : `${start} ~ ${end}`;
  }, [q.data]);

  const HeadingTag = heading;

  return (
    <section className="space-y-4">
      <div>
        <HeadingTag
          className={
            heading === "h1"
              ? "text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl"
              : "text-base font-semibold text-slate-900"
          }
        >
          서울시 시중은행 협력자금 실행금리
        </HeadingTag>
        {periodLabel ? (
          <p className="mt-1 text-xs text-slate-500">적용 기간 {periodLabel}</p>
        ) : null}
        <p className="mt-2 text-xs leading-5 text-slate-600">
          서울시 공공데이터에서 제공하는 중소기업육성자금 협력자금 실행금리입니다.
          일반 시중은행 주택담보대출 공시금리와는 다릅니다.
        </p>
      </div>

      {q.isLoading ? (
        <div
          className="h-32 animate-pulse rounded-xl border border-slate-200 bg-slate-100/70"
          aria-hidden
        />
      ) : q.isError ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {(q.error as Error).message}
          <p className="mt-1 text-xs text-rose-700">
            OpenAPI 키가 필요하면 SEOUL_OPENAPI_KEY를 설정하세요.
          </p>
        </div>
      ) : (
        <>
          {q.data?.usingSampleKey || q.data?.partial ? (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {q.data.usingSampleKey
                ? `샘플 키로 ${q.data.items.length}건만 표시합니다 (전체 ${q.data.totalCount}건).`
                : `일부 페이지만 불러왔습니다 (${q.data.items.length}/${q.data.totalCount}건).`}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setFilter("all")}
                className={`rounded-md px-2.5 py-1 font-medium ${
                  filter === "all" ? "bg-slate-900 text-white" : "text-slate-600"
                }`}
              >
                전체
              </button>
              <button
                type="button"
                onClick={() => setFilter("first")}
                className={`rounded-md px-2.5 py-1 font-medium ${
                  filter === "first" ? "bg-slate-900 text-white" : "text-slate-600"
                }`}
              >
                1금융
              </button>
            </div>
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              정렬
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-800"
              >
                <option value="min">최저금리</option>
                <option value="avg">평균금리</option>
                <option value="name">기관명</option>
              </select>
            </label>
            <span className="ml-auto text-[11px] text-slate-400">{rows.length}곳</span>
          </div>

          {rows.length === 0 ? (
            <p className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
              표시할 금리 정보가 없습니다.
            </p>
          ) : (
            <>
              <div className="grid gap-2.5 md:hidden">
                {rows.map((row) => (
                  <RateCard key={row.orgCode || row.orgName} row={row} />
                ))}
              </div>

              <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white md:block">
                <table className="w-full min-w-[640px] border-collapse text-sm">
                  <thead className="bg-slate-50 text-left text-xs text-slate-500">
                    <tr>
                      <th className="px-3 py-2.5 font-medium">금융기관</th>
                      <th className="px-3 py-2.5 font-medium">기간</th>
                      <th className="px-3 py-2.5 font-medium">건수</th>
                      <th className="px-3 py-2.5 font-medium">최저</th>
                      <th className="px-3 py-2.5 font-medium">평균</th>
                      <th className="px-3 py-2.5 font-medium">최고</th>
                      <th className="px-3 py-2.5 font-medium">보전평균</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr
                        key={row.orgCode || row.orgName}
                        className={`border-t border-slate-100 ${
                          index === 0 && sort === "min" ? "bg-slate-50" : ""
                        }`}
                      >
                        <td className="px-3 py-2.5 font-medium text-slate-900">
                          {row.orgName}
                          <span className="ml-1.5 text-[10px] font-normal text-slate-400">
                            {row.isFirstTier ? "1금융" : "기타"}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-xs text-slate-500">
                          {row.periodStart} ~ {row.periodEnd}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums text-slate-700">
                          {row.loanCount.toLocaleString("ko-KR")}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums font-semibold text-slate-900">
                          {formatPct(row.minRate)}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums text-slate-700">
                          {formatPct(row.avgRate)}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums text-slate-700">
                          {formatPct(row.maxRate)}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums text-slate-500">
                          {formatPct(row.avgSubsidyRate)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <p className="text-[11px] leading-5 text-slate-400">
            출처:{" "}
            <a
              href={DATASET_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-teal-700 hover:underline"
            >
              서울 열린데이터광장 OA-21098 시중은행협력자금 실행금리
              <ExternalLink className="h-3 w-3" />
            </a>
            · 서울특별시. 캐시 최대 1시간.
            {q.data?.fetchedAt
              ? ` 갱신 ${new Date(q.data.fetchedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}.`
              : ""}
          </p>
        </>
      )}
    </section>
  );
}
