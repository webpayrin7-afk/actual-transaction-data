"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LabSection as Section } from "@/components/ui/LabSection";
import { LabTag } from "@/components/ui/LabTag";
import { LAB_EXPERIMENTS, getLabDef } from "@/lib/lab/definitions";
import type { LabExperimentResult, LabHomeResponse } from "@/lib/lab/types";

export async function fetchLab(): Promise<LabHomeResponse> {
  const res = await fetch("/api/lab");
  if (!res.ok) throw new Error("실험실 데이터를 불러오지 못했습니다.");
  return res.json();
}

export const LAB_QUERY_KEY = ["lab-home"] as const;

/** 한국 날짜 기준 날짜 번호 (1970-01-01부터 며칠째) — 한국 자정에 바뀐다. */
function seoulDayNumber(now = Date.now()): number {
  return Math.floor((now + 9 * 3_600_000) / 86_400_000);
}

/** 오늘의 실험 — 한국 날짜가 바뀔 때마다 다음 실험이 맨 위에 온다 (답이 있는 실험만). */
export function pickTodaysExperiment(data: LabHomeResponse): LabExperimentResult | null {
  const ready = data.experiments.filter((e) => e.headline && e.headline !== "표본 부족");
  if (ready.length === 0) return null;
  return ready[seoulDayNumber() % ready.length]!;
}

/**
 * 시장 홈의 '오늘의 실험실' — 오늘의 실험 한 개를 크게, 나머지는 질문·답 한 줄씩.
 * 전체 실험(그래프·실험 방법)은 /lab.
 */
export function LabSection() {
  const query = useQuery({
    queryKey: LAB_QUERY_KEY,
    queryFn: fetchLab,
    staleTime: 10 * 60 * 1000,
  });
  const data = query.data;
  if (query.isError || (data && data.experiments.length === 0)) return null;

  const today = data ? pickTodaysExperiment(data) : null;
  // 오늘의 실험 다음 번호부터 4개 — 날마다 목록도 함께 돈다
  const others = (() => {
    if (!data) return [];
    const list = data.experiments;
    const start = today ? list.findIndex((e) => e.id === today.id) + 1 : 0;
    return [...list.slice(start), ...list.slice(0, start)].filter((e) => e.id !== today?.id).slice(0, 4);
  })();
  const todayDef = today ? getLabDef(today.id) : null;

  return (
    <Section
      id="market-lab"
      title="오늘의 실험실"
      meta={data ? `${data.coverageShort} · 최근 30일` : undefined}
      tip={
        <p>
          실거래 데이터를 조금 다른 방법으로 들여다보는 집랩의 실험입니다. 같은 단지·같은 평형끼리
          비교하는 식으로 지역 차이를 덜어 내고 봅니다. 결과는 표본과 방법에 따라 달라질 수 있어
          참고용입니다.
        </p>
      }
    >
      {query.isLoading ? <div className="lab-skeleton" aria-label="실험실 불러오는 중" /> : null}

      {today && todayDef ? (
        <Link
          href={`/lab#${todayDef.slug}`}
          className="flex flex-col gap-1.5 rounded-xl border border-[color:var(--lab-border)] p-4 transition-colors hover:border-[color:var(--lab-brand-border)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--lab-teal-600)]"
        >
          <span className="flex items-center gap-1.5">
            <LabTag>오늘의 실험</LabTag>
            <span className="detail-meta">
              {todayDef.labNo} · {todayDef.title}
            </span>
          </span>
          <span className="detail-data-value-emphasis break-keep">{todayDef.question}</span>
          <span className="text-[20px] font-bold leading-7 tracking-tight text-[color:var(--lab-teal-700)] tabular-nums">
            {today.headline}
          </span>
          <span className="detail-body line-clamp-3 text-[color:var(--lab-muted)]">{today.insight}</span>
        </Link>
      ) : null}

      {others.length > 0 ? (
        <ul className={LAB_LIST}>
          {others.map((e) => {
            const def = getLabDef(e.id);
            return (
              <LabListRow
                key={e.id}
                href={`/lab#${def.slug}`}
                title={def.question}
                meta={
                  <span className="font-semibold text-[color:var(--lab-teal-700)] tabular-nums">
                    {e.headline}
                  </span>
                }
              />
            );
          })}
        </ul>
      ) : null}

      {data ? (
        <Link href="/lab" className="lab-button lab-button-secondary w-full">
          실험 {LAB_EXPERIMENTS.length}개 모두 보기
          <span aria-hidden className="ml-1">
            →
          </span>
        </Link>
      ) : null}
    </Section>
  );
}
