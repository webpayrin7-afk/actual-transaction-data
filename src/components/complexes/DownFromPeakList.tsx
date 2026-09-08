"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { DownFromPeakResponse } from "@/lib/complexes/down-from-peak";
import {
  formatArea,
  formatDealDate,
  formatEok,
} from "@/lib/utils/format";

async function fetchDownFromPeak(): Promise<DownFromPeakResponse> {
  const res = await fetch("/api/complexes/down-from-peak");
  if (!res.ok) throw new Error("고점 대비 내려온 단지를 불러오지 못했습니다.");
  return res.json();
}

function formatDropPct(pct: number): string {
  const rounded = Math.round(pct * 10) / 10;
  return `${rounded.toFixed(1)}%`;
}

export function DownFromPeakList() {
  const query = useQuery({
    queryKey: ["complexes-down-from-peak"],
    queryFn: fetchDownFromPeak,
    staleTime: 5 * 60 * 1000,
  });

  const data = query.data;

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold text-slate-900 sm:text-lg">
          고점 대비 내려온 단지
        </h2>
        <p className="mt-0.5 text-xs text-slate-500 sm:text-sm">
          최근 실거래가가 과거 최고가보다 낮아진 단지를 확인해보세요.
        </p>
      </div>

      {query.isLoading ? (
        <div className="h-52 animate-pulse rounded-xl border border-slate-200 bg-slate-50" />
      ) : query.isError ? (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {(query.error as Error).message}
        </p>
      ) : !data?.items.length ? (
        <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-6 text-center text-sm text-slate-500">
          최근 거래 기준으로 고점 대비 10% 이상 내려온 단지가 없습니다.
        </p>
      ) : (
        <>
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
            {data.items.map((item) => (
              <li
                key={`${item.aptNameNorm}|${item.lawdCd}|${item.dong}|${item.areaKey}`}
              >
                <Link
                  href={item.href}
                  className="flex items-start gap-3 px-3.5 py-2.5 transition hover:bg-slate-50 sm:items-center sm:px-4"
                >
                  <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs font-semibold tabular-nums text-slate-600 sm:mt-0">
                    {item.rank}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-900">
                      {item.aptName}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-slate-500">
                      {item.regionLabel} · {formatArea(item.exclusiveArea)}
                    </span>
                    <span className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-slate-600 sm:text-[13px]">
                      <span>
                        최근{" "}
                        <span className="font-semibold tabular-nums text-slate-900">
                          {formatEok(item.latestAmount)}
                        </span>
                      </span>
                      <span className="text-slate-400">·</span>
                      <span>
                        고점{" "}
                        <span className="tabular-nums text-slate-700">
                          {formatEok(item.peakAmount)}
                        </span>
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[11px] text-slate-400 sm:text-xs">
                      최근 거래 {formatDealDate(item.latestDealDate)}
                    </span>
                  </span>
                  <span className="shrink-0 pt-0.5 text-right sm:pt-0">
                    <span className="block text-sm font-semibold tabular-nums text-slate-900">
                      {formatDropPct(item.dropPct)}
                    </span>
                    <span className="mt-0.5 block text-[11px] tabular-nums text-slate-500 sm:text-xs">
                      {item.dropAmount >= 0 ? "+" : "−"}
                      {formatEok(Math.abs(item.dropAmount))}
                    </span>
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
