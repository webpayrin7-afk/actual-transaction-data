"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LAB_EXPERIMENTS,
  LAB_FEATURED_ID,
  getLabDef,
  type LabExperimentId,
} from "@/lib/lab/definitions";
import type {
  LabBucketRow,
  LabExperimentResult,
  LabHomeResponse,
  LabRankRow,
} from "@/lib/lab/types";

async function fetchLab(): Promise<LabHomeResponse> {
  const res = await fetch("/api/lab");
  if (!res.ok) throw new Error("실험실 데이터를 불러오지 못했습니다.");
  return res.json();
}

function ShareBar({ pct }: { pct: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div
        className="h-full rounded-full bg-teal-600/80"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  );
}

function RankTable({
  rows,
  mode,
}: {
  rows: LabRankRow[];
  mode: "growth" | "count";
}) {
  if (rows.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-slate-500">
        표시할 결과가 없습니다.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[280px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            <th className="py-2 pr-2 font-medium">#</th>
            <th className="py-2 pr-2 font-medium">지역</th>
            {mode === "growth" ? (
              <>
                <th className="py-2 pr-2 text-right font-medium">최근</th>
                <th className="py-2 pr-2 text-right font-medium">직전</th>
                <th className="py-2 text-right font-medium">증감률</th>
              </>
            ) : (
              <>
                <th className="py-2 pr-2 text-right font-medium">거래</th>
                <th className="py-2 text-right font-medium">비중</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.rank}-${row.label}`}
              className="border-b border-slate-100 last:border-0"
            >
              <td className="py-2.5 pr-2 tabular-nums text-slate-400">
                {row.rank}
              </td>
              <td className="max-w-[9.5rem] truncate py-2.5 pr-2 font-medium text-slate-900 sm:max-w-none">
                {row.href ? (
                  <Link href={row.href} className="hover:text-teal-800 hover:underline">
                    {row.label}
                  </Link>
                ) : (
                  row.label
                )}
              </td>
              {mode === "growth" ? (
                <>
                  <td className="py-2.5 pr-2 text-right tabular-nums text-slate-800">
                    {row.recentCount.toLocaleString("ko-KR")}
                  </td>
                  <td className="py-2.5 pr-2 text-right tabular-nums text-slate-500">
                    {(row.priorCount ?? 0).toLocaleString("ko-KR")}
                  </td>
                  <td className="py-2.5 text-right font-semibold tabular-nums text-teal-800">
                    {row.growthPct != null ? `+${row.growthPct}%` : "—"}
                  </td>
                </>
              ) : (
                <>
                  <td className="py-2.5 pr-2 text-right tabular-nums text-slate-800">
                    {row.recentCount.toLocaleString("ko-KR")}건
                  </td>
                  <td className="py-2.5 text-right tabular-nums text-slate-600">
                    {row.sharePct != null ? `${row.sharePct}%` : "—"}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BucketList({ buckets }: { buckets: LabBucketRow[] }) {
  const max = Math.max(...buckets.map((b) => b.count), 1);
  return (
    <ul className="space-y-2.5">
      {buckets.map((b) => (
        <li key={b.key}>
          <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
            <span className="min-w-0 truncate font-medium text-slate-800">
              {b.label}
            </span>
            <span className="shrink-0 tabular-nums text-slate-600">
              {b.count.toLocaleString("ko-KR")}건 · {b.sharePct}%
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-teal-600/75"
              style={{ width: `${(b.count / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function ExperimentBody({ result }: { result: LabExperimentResult }) {
  if (result.ranks) {
    return (
      <RankTable
        rows={result.ranks}
        mode={result.id === "volume-thermometer" ? "growth" : "count"}
      />
    );
  }
  if (result.buckets) {
    return <BucketList buckets={result.buckets} />;
  }
  return null;
}

function FeaturedCard({ result }: { result: LabExperimentResult }) {
  const def = getLabDef(result.id);
  return (
    <article className="rounded-2xl border border-teal-200/80 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold tracking-wider text-teal-800">
          {def.labNo}
        </span>
        <span className="text-[11px] text-slate-400">·</span>
        <span className="text-[11px] font-medium text-slate-500">
          {def.title}
        </span>
      </div>
      <h3 className="mt-2 text-base font-semibold leading-snug text-slate-900 sm:text-lg">
        {def.question}
      </h3>
      <p className="mt-1.5 text-xs text-slate-500">{result.period.label}</p>
      {result.period.priorLabel ? (
        <p className="text-xs text-slate-400">
          비교 {result.period.priorLabel}
        </p>
      ) : null}

      <div className="mt-4">
        <ExperimentBody result={result} />
      </div>

      <p className="mt-4 border-t border-slate-100 pt-3 text-sm leading-relaxed text-slate-700">
        {result.insight}
      </p>
    </article>
  );
}

function CompactExperiment({
  result,
  active,
  onSelect,
}: {
  result: LabExperimentResult;
  active: boolean;
  onSelect: () => void;
}) {
  const def = getLabDef(result.id);
  const preview =
    result.ranks?.[0] != null
      ? result.id === "volume-thermometer"
        ? `${result.ranks[0].label} +${result.ranks[0].growthPct}%`
        : `${result.ranks[0].label} ${result.ranks[0].recentCount.toLocaleString("ko-KR")}건`
      : result.buckets?.[0] != null
        ? `${[...result.buckets].sort((a, b) => b.count - a.count)[0]!.label} ${[...result.buckets].sort((a, b) => b.count - a.count)[0]!.sharePct}%`
        : "데이터 없음";

  return (
    <div
      className={`rounded-xl border bg-white transition ${
        active
          ? "border-teal-300 shadow-sm"
          : "border-slate-200 hover:border-slate-300"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-expanded={active}
        className="flex w-full items-start gap-3 px-3.5 py-3 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold tracking-wider text-teal-800">
              {def.labNo}
            </span>
            <span className="text-[10px] text-slate-400">·</span>
            <span className="text-[10px] font-medium text-slate-500">
              {def.title}
            </span>
          </div>
          <p className="mt-1 text-sm font-medium leading-snug text-slate-900">
            {def.question}
          </p>
          <p className="mt-1 truncate text-xs tabular-nums text-teal-800">
            {preview}
          </p>
        </div>
        <span className="mt-0.5 shrink-0 text-xs text-slate-400">
          {active ? "접기" : "보기"}
        </span>
      </button>

      {active ? (
        <div className="border-t border-slate-100 px-3.5 pb-3.5 pt-3">
          <p className="mb-3 text-[11px] text-slate-500">{result.period.label}</p>
          <ExperimentBody result={result} />
          <p className="mt-3 text-xs leading-relaxed text-slate-600">
            {result.insight}
          </p>
          {result.excludedNote ? (
            <p className="mt-1.5 text-[11px] text-slate-400">
              {result.excludedNote}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="border-t border-slate-50 px-3.5 pb-3">
          {result.buckets ? (
            <ShareBar
              pct={
                [...result.buckets].sort((a, b) => b.count - a.count)[0]
                  ?.sharePct ?? 0
              }
            />
          ) : result.ranks?.[0] ? (
            <p className="text-[11px] text-slate-400">
              Top {result.ranks.length} · {result.period.label}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function LabSection() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["lab-home"],
    queryFn: fetchLab,
    staleTime: 5 * 60 * 1000,
  });

  const featured = useMemo(
    () => data?.experiments.find((e) => e.id === (data.featuredId ?? LAB_FEATURED_ID)),
    [data],
  );

  const others = useMemo(() => {
    if (!data) return [];
    const featuredId = data.featuredId ?? LAB_FEATURED_ID;
    return LAB_EXPERIMENTS.filter((d) => d.id !== featuredId)
      .map((d) => data.experiments.find((e) => e.id === d.id))
      .filter((e): e is LabExperimentResult => Boolean(e));
  }, [data]);

  const [activeId, setActiveId] = useState<LabExperimentId | null>("area-84");

  if (isLoading) {
    return (
      <section
        aria-label="오늘의 실험실"
        className="border-t border-slate-200/80 pt-8"
      >
        <div className="h-8 w-40 animate-pulse rounded bg-slate-200/70" />
        <div className="mt-3 h-4 w-72 max-w-full animate-pulse rounded bg-slate-200/50" />
        <div className="mt-6 h-48 animate-pulse rounded-2xl bg-slate-200/40" />
      </section>
    );
  }

  if (isError || !data || data.source === "empty") {
    return (
      <section
        aria-label="오늘의 실험실"
        className="border-t border-slate-200/80 pt-8"
      >
        <LabHeader />
        <p className="mt-4 text-sm text-slate-500">
          {data?.warning ?? "실험실 데이터를 불러오지 못했습니다."}
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="오늘의 실험실"
      className="border-t border-slate-200/80 pt-8"
    >
      <LabHeader />

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <span>{data.coverageLabel}</span>
        <span className="text-slate-300">·</span>
        <span>기준 계약일 {data.asOfDate}</span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
        {data.dateBasisNote}
      </p>

      <div className="mt-5 space-y-4">
        {featured ? <FeaturedCard result={featured} /> : null}

        <div className="space-y-2.5">
          <p className="text-xs font-medium text-slate-500">다른 실험</p>
          {others.map((result) => (
            <CompactExperiment
              key={result.id}
              result={result}
              active={activeId === result.id}
              onSelect={() =>
                setActiveId((cur) => (cur === result.id ? null : result.id))
              }
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function LabHeader() {
  return (
    <header className="max-w-3xl">
      <h2 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
        오늘의 실험실
      </h2>
      <p className="mt-1.5 text-sm text-slate-600">
        실거래 데이터를 조금 다른 방법으로 들여다봅니다.
      </p>
      <p className="mt-1 text-xs text-slate-500">
        가격·거래량·면적·층·연식 등 다양한 관점에서 실제 거래를 살펴봅니다.
      </p>
    </header>
  );
}
