"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { Clock3, X } from "lucide-react";
import {
  clearRecentComplexes,
  getRecentComplexesServerSnapshot,
  getRecentComplexesSnapshot,
  recentComplexHref,
  subscribeRecentComplexes,
} from "@/lib/complexes/recent-views";

export function RecentComplexList() {
  const items = useSyncExternalStore(
    subscribeRecentComplexes,
    getRecentComplexesSnapshot,
    getRecentComplexesServerSnapshot,
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900 sm:text-lg">
            최근 조회한 단지
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 sm:text-sm">
            이전에 본 단지를 바로 다시 열어보세요
          </p>
        </div>
        {items.length > 0 ? (
          <button
            type="button"
            onClick={() => clearRecentComplexes()}
            className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-800"
          >
            <X className="h-3.5 w-3.5" />
            전체 삭제
          </button>
        ) : null}
      </div>

      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-6 text-center text-sm text-slate-500">
          아직 조회한 단지가 없습니다. 위 검색에서 궁금한 아파트를 찾아보세요.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {items.map((item) => (
            <li key={`${item.regionSlug}-${item.aptName}-${item.gu ?? ""}`}>
              <Link
                href={recentComplexHref(item)}
                className="flex items-center gap-3 px-3.5 py-2.5 transition hover:bg-slate-50 sm:px-4"
              >
                <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                  <Clock3 className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-slate-900">
                    {item.aptName}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-slate-500">
                    {item.regionLabel}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
