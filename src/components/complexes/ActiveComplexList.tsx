"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { ActiveComplexesResponse } from "@/lib/complexes/active-complexes";
import { formatDealDate } from "@/lib/utils/format";

async function fetchActive(): Promise<ActiveComplexesResponse> {
  const res = await fetch("/api/complexes/active");
  if (!res.ok) throw new Error("거래 활발 단지를 불러오지 못했습니다.");
  return res.json();
}

export function ActiveComplexList() {
  const query = useQuery({
    queryKey: ["complexes-active"],
    queryFn: fetchActive,
    staleTime: 5 * 60 * 1000,
  });

  const data = query.data;

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold text-slate-900 sm:text-lg">
          최근 거래 활발 단지
        </h2>
        <p className="mt-0.5 text-xs text-slate-500 sm:text-sm">
          최근 30일 매매 거래건수가 많았던 단지입니다
        </p>
      </div>

      {query.isLoading ? (
        <div className="h-40 animate-pulse rounded-xl border border-slate-200 bg-slate-50" />
      ) : query.isError ? (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {(query.error as Error).message}
        </p>
      ) : !data?.items.length ? (
        <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-6 text-center text-sm text-slate-500">
          표시할 거래 활발 단지가 없습니다.
        </p>
      ) : (
        <>
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
            {data.items.map((item) => (
              <li key={`${item.aptNameNorm}|${item.lawdCd}|${item.dong}`}>
                <Link
                  href={item.href}
                  className="flex items-center gap-3 px-3.5 py-2.5 transition hover:bg-slate-50 sm:px-4"
                >
                  <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs font-semibold tabular-nums text-slate-600">
                    {item.rank}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-900">
                      {item.aptName}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-slate-500">
                      {item.regionLabel}
                      {item.latestDealDate
                        ? ` · 최근 ${formatDealDate(item.latestDealDate)}`
                        : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs font-semibold tabular-nums text-teal-800 sm:text-sm">
                    {item.recentCount.toLocaleString("ko-KR")}건
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {data.note ? (
            <p className="text-[11px] leading-5 text-slate-400">{data.note}</p>
          ) : null}
        </>
      )}
    </section>
  );
}
