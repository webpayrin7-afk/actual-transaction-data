"use client";

import Link from "next/link";
import { useState } from "react";
import {
  GYEONGGI_REGIONS,
  SEOUL_REGIONS,
  type Metro,
} from "@/lib/constants/regions";

/**
 * /complexes용 지역 → 단지 발견 진입점.
 * KPI/시장 분석 없이 동별 단지 목록(tab=dong)으로만 연결한다.
 */
export function RegionComplexBrowse() {
  const [metro, setMetro] = useState<Metro>("seoul");
  const regions = metro === "seoul" ? SEOUL_REGIONS : GYEONGGI_REGIONS;

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold text-slate-900 sm:text-lg">
          지역으로 단지 찾기
        </h2>
        <p className="mt-0.5 text-xs text-slate-500 sm:text-sm">
          단지명을 모를 때 지역을 고르면 해당 지역 단지 목록으로 이동합니다
        </p>
      </div>

      <div className="inline-flex w-fit gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
        {(
          [
            { value: "seoul" as const, label: "서울" },
            { value: "gyeonggi" as const, label: "경기" },
          ] as const
        ).map((opt) => {
          const active = metro === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setMetro(opt.value)}
              className={`min-h-8 rounded-md px-3 text-xs font-medium transition sm:text-[13px] ${
                active
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
        {regions.map((region) => (
          <Link
            key={region.slug}
            href={`/region/${region.slug}?tab=dong`}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-center text-xs font-medium text-slate-800 transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-900 sm:text-sm"
          >
            {region.name}
          </Link>
        ))}
      </div>

      <p className="text-xs text-slate-500">
        지역 시장 현황이 필요하면{" "}
        <Link
          href="/regions"
          className="font-medium text-teal-700 underline-offset-2 hover:underline"
        >
          지역별 조회
        </Link>
        로 이동하세요.
      </p>
    </section>
  );
}
