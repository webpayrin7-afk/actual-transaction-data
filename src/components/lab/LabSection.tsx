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
import {
  LAB_SECTION_SURFACE,
  LAB_SUBSECTION_RULE,
  LabSectionHeader,
  LabSubsectionHeader,
} from "@/components/ui/LabSection";
import { LAB_LIST } from "@/components/ui/LabListRow";
import { LabTag } from "@/components/ui/LabTag";

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
      <p className="lab-state">
        표시할 결과가 없습니다.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[280px] border-collapse text-left text-[14px] leading-5">
        <thead>
          <tr className="detail-label border-b border-[color:var(--lab-border)]">
            <th className="py-2.5 pr-2 font-medium">#</th>
            <th className="py-2.5 pr-2 font-medium">지역</th>
            {mode === "growth" ? (
              <>
                <th className="py-2.5 pr-2 text-right font-medium">최근</th>
                <th className="py-2.5 pr-2 text-right font-medium">직전</th>
                <th className="py-2.5 text-right font-medium">증감률</th>
              </>
            ) : (
              <>
                <th className="py-2.5 pr-2 text-right font-medium">거래</th>
                <th className="py-2.5 text-right font-medium">비중</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.rank}-${row.label}`}
              className="border-b border-[color:var(--lab-border)] last:border-0"
            >
              <td className="py-3 pr-2 tabular-nums text-[color:var(--lab-muted)]">
                {row.rank}
              </td>
              <td className="max-w-[9.5rem] truncate py-3 pr-2 font-semibold text-[color:var(--lab-navy-900)] sm:max-w-none">
                {row.href ? (
                  <Link href={row.href} className="-my-3 block truncate py-3 hover:underline">
                    {row.label}
                  </Link>
                ) : (
                  row.label
                )}
              </td>
              {mode === "growth" ? (
                <>
                  <td className="py-3 pr-2 text-right tabular-nums text-slate-900">
                    {row.recentCount.toLocaleString("ko-KR")}
                  </td>
                  <td className="py-3 pr-2 text-right tabular-nums text-slate-900">
                    {(row.priorCount ?? 0).toLocaleString("ko-KR")}
                  </td>
                  <td className="py-3 text-right font-semibold tabular-nums" style={{ color: "var(--lab-change-up)" }}>
                    {row.growthPct != null ? `+${row.growthPct}%` : "—"}
                  </td>
                </>
              ) : (
                <>
                  <td className="py-3 pr-2 text-right tabular-nums text-slate-900">
                    {row.recentCount.toLocaleString("ko-KR")}건
                  </td>
                  <td className="py-3 text-right tabular-nums text-slate-900">
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
          <div className="mb-1 flex items-baseline justify-between gap-2 text-[14px] leading-5">
            <span className="min-w-0 truncate font-medium text-slate-800">
              {b.label}
            </span>
            <span className="shrink-0 tabular-nums text-slate-900">
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
    <article className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <LabTag>{def.labNo}</LabTag>
        <span className="detail-label">{def.title}</span>
      </div>
      <div>
        <LabSubsectionHeader title={def.question} />
        <p className="detail-meta">
          {result.period.label}
          {result.period.priorLabel ? ` · 비교 ${result.period.priorLabel}` : ""}
        </p>
      </div>
      <ExperimentBody result={result} />
      <p className="detail-body">{result.insight}</p>
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
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-expanded={active}
        className="flex min-h-11 w-full items-start gap-3 py-3 text-left hover:bg-slate-50"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <LabTag>{def.labNo}</LabTag>
            <span className="detail-meta">{def.title}</span>
          </div>
          <p className="detail-data-value-emphasis mt-1">{def.question}</p>
          <p className="detail-data-value mt-0.5 truncate tabular-nums">{preview}</p>
        </div>
        <span
          className="detail-label mt-0.5 shrink-0 font-semibold"
          style={{ color: "var(--lab-brand-primary)" }}
        >
          {active ? "접기" : "보기"}
        </span>
      </button>

      {active ? (
        <div className="flex flex-col gap-3 pb-4">
          <p className="detail-meta">{result.period.label}</p>
          <ExperimentBody result={result} />
          <p className="detail-body">{result.insight}</p>
          {result.excludedNote ? (
            <p className="detail-meta">{result.excludedNote}</p>
          ) : null}
        </div>
      ) : (
        <div className="pb-3">
          {result.buckets ? (
            <ShareBar
              pct={
                [...result.buckets].sort((a, b) => b.count - a.count)[0]
                  ?.sharePct ?? 0
              }
            />
          ) : result.ranks?.[0] ? (
            <p className="detail-meta">
              Top {result.ranks.length} · {result.period.label}
            </p>
          ) : null}
        </div>
      )}
    </li>
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
        className={`${LAB_SECTION_SURFACE} flex flex-col gap-3`}
      >
        <LabHeader />
        <div className="h-48 animate-pulse rounded-xl bg-slate-100" />
      </section>
    );
  }

  if (isError || !data || data.source === "empty") {
    return (
      <section
        aria-label="오늘의 실험실"
        className={`${LAB_SECTION_SURFACE} flex flex-col gap-3`}
      >
        <LabHeader />
        <p className="lab-state">
          {data?.warning ?? "실험실 데이터를 불러오지 못했습니다."}
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="오늘의 실험실"
      className={`${LAB_SECTION_SURFACE} flex flex-col gap-4`}
    >
      <div>
        <LabHeader meta={`${data.coverageLabel} · 기준 계약일 ${data.asOfDate}`} />
        <p className="detail-meta mt-1">{data.dateBasisNote}</p>
      </div>

      {featured ? <FeaturedCard result={featured} /> : null}

      <div className={`${LAB_SUBSECTION_RULE} flex flex-col gap-1`}>
        <LabSubsectionHeader title="다른 실험" />
        <ul className={LAB_LIST}>
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
        </ul>
      </div>
    </section>
  );
}

function LabHeader({ meta }: { meta?: string }) {
  return (
    <div>
      <LabSectionHeader title="오늘의 실험실" meta={meta} />
      <p className="detail-body mt-1">
        실거래 데이터를 조금 다른 방법으로 들여다봅니다. 가격·거래량·면적·층·연식
        등 다양한 관점에서 실제 거래를 살펴봅니다.
      </p>
    </div>
  );
}
