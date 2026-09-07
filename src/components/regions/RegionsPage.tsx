"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  GYEONGGI_REGIONS,
  SEOUL_REGIONS,
  type RegionDef,
} from "@/lib/constants/regions";

function RegionGrid({
  title,
  regions,
}: {
  title: string;
  regions: RegionDef[];
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
        <span className="h-5 w-1 rounded-full bg-teal-600" />
        {title}
      </h2>
      {regions.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
          검색 결과가 없습니다.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {regions.map((region) => (
            <Link
              key={region.slug}
              href={`/region/${region.slug}`}
              className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm font-medium text-slate-800 transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-900"
            >
              {region.name}
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

export function RegionsPage() {
  const [regionQuery, setRegionQuery] = useState("");

  useEffect(() => {
    const hash = window.location.hash.replace("#", "");
    if (!hash) return;
    const el = document.getElementById(hash);
    if (!el) return;
    window.setTimeout(() => {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }, []);

  const filteredSeoul = useMemo(() => {
    const q = regionQuery.trim();
    if (!q) return SEOUL_REGIONS;
    return SEOUL_REGIONS.filter(
      (r) => r.name.includes(q) || r.fullName.includes(q),
    );
  }, [regionQuery]);

  const filteredGyeonggi = useMemo(() => {
    const q = regionQuery.trim();
    if (!q) return GYEONGGI_REGIONS;
    return GYEONGGI_REGIONS.filter(
      (r) => r.name.includes(q) || r.fullName.includes(q),
    );
  }, [regionQuery]);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <section className="relative overflow-hidden rounded-3xl border border-teal-900/10 bg-gradient-to-br from-slate-900 via-teal-900 to-slate-800 px-5 py-7 text-white shadow-lg sm:px-8">
        <div
          className="pointer-events-none absolute inset-0 opacity-35"
          style={{
            backgroundImage:
              "radial-gradient(circle at 15% 20%, rgba(45,212,191,0.35), transparent 42%), radial-gradient(circle at 85% 0%, rgba(56,189,248,0.22), transparent 38%)",
          }}
        />
        <div className="relative">
          <p className="text-sm font-medium tracking-wide text-teal-100/90">
            아파트 실거래
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            지역별 조회
          </h1>
          <p className="mt-2 max-w-xl text-sm text-teal-50/85 sm:text-base">
            서울 25개 구 · 경기 31개 시·군을 골라 실거래를 확인하세요.
          </p>
        </div>
      </section>

      <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-3 border-b border-slate-200 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">지역 선택</h2>
            <p className="mt-1 text-sm text-slate-500">
              서울 25개 구 · 경기 31개 시·군
            </p>
          </div>
          <input
            value={regionQuery}
            onChange={(e) => setRegionQuery(e.target.value)}
            placeholder="지역명 검색 (예: 강남, 분당, 수원)"
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-teal-500 focus:bg-white focus:ring-2 focus:ring-teal-500/20 sm:max-w-xs"
          />
        </div>

        <div className="mt-5 flex flex-col gap-8">
          <div id="seoul" className="scroll-mt-24">
            <RegionGrid title="서울특별시" regions={filteredSeoul} />
          </div>
          <div id="gyeonggi" className="scroll-mt-24">
            <RegionGrid title="경기도" regions={filteredGyeonggi} />
          </div>
        </div>
      </div>

      <footer className="border-t border-slate-200 pt-4 pb-8 text-center text-xs text-slate-400">
        국토교통부 아파트 실거래 OpenAPI 기반 · 아파트 실거래
      </footer>
    </div>
  );
}
