"use client";

import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { LabExperimentCard } from "@/components/lab/LabExperimentCard";
import { LAB_QUERY_KEY, fetchLab } from "@/components/lab/LabSection";
import { BackLink } from "@/components/layout/BackLink";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { LabSectionBoundary } from "@/components/ui/LabSectionBoundary";
import { LabStickySectionNav } from "@/components/ui/LabStickySectionNav";
import { LabTag } from "@/components/ui/LabTag";
import { LAB_EXPERIMENTS, getLabDef } from "@/lib/lab/definitions";

const SECTIONS = LAB_EXPERIMENTS.map((d) => ({ id: d.slug, label: d.shortTitle }));

function fmtDot(iso: string): string {
  return `${iso.slice(0, 4)}.${iso.slice(5, 7)}.${iso.slice(8, 10)}`;
}

/** /lab — 실험을 모아 두는 곳. 번호 순으로 쌓인다 (오늘의 실험 순환은 시장 홈에서만). */
export function LabPage() {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const query = useQuery({ queryKey: LAB_QUERY_KEY, queryFn: fetchLab, staleTime: 10 * 60 * 1000 });
  const data = query.data;
  const ordered = data
    ? LAB_EXPERIMENTS.map((d) => data.experiments.find((e) => e.id === d.id)).filter(
        (e): e is NonNullable<typeof e> => e != null,
      )
    : [];

  return (
    <div className={PAGE_SHELL}>
      <PageHeader
        leading={<BackLink fallback="/" compact hideLabel />}
        title="오늘의 실험실"
        titleSuffix={<LabTag size="md">LAB</LabTag>}
        description="실거래 데이터를 조금 다른 방법으로 들여다봅니다. 같은 단지·같은 평형끼리 비교하는 식으로 지역 차이를 덜어 내고 봅니다."
        meta={
          data?.asOfDate ? (
            <div className="flex flex-wrap items-center gap-1">
              <LabTag size="md">{data.coverageLabel}</LabTag>
              <LabTag size="md">기준 계약일 {fmtDot(data.asOfDate)}</LabTag>
            </div>
          ) : null
        }
      />
      <div ref={anchorRef} className="-mb-5 h-0 sm:-mb-6" aria-hidden />
      <LabStickySectionNav anchor={anchorRef} sections={SECTIONS} title="오늘의 실험실" ariaLabel="실험 목록" />

      {query.isLoading ? <div className="lab-skeleton" aria-label="실험실 불러오는 중" /> : null}
      {query.isError ? (
        <div className="flex flex-col gap-3">
          <p className="lab-state lab-state-error">실험실 데이터를 불러오지 못했습니다.</p>
          <button type="button" className="lab-button lab-button-primary w-full" onClick={() => void query.refetch()}>
            다시 시도
          </button>
        </div>
      ) : null}
      {data?.warning ? <p className="lab-state">{data.warning}</p> : null}

      <div className="grid grid-cols-1 gap-5 sm:gap-6 lg:grid-cols-2 lg:items-start lg:gap-8">
        {ordered.map((e) => (
          <LabSectionBoundary key={e.id} id={getLabDef(e.id).slug} title={getLabDef(e.id).title}>
            <LabExperimentCard result={e} />
          </LabSectionBoundary>
        ))}
      </div>

      {data ? <p className="detail-meta">{data.dateBasisNote}</p> : null}
    </div>
  );
}
