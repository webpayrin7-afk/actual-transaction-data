"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LabSection } from "@/components/ui/LabSection";
import { LabTag } from "@/components/ui/LabTag";
import { LabMoreButton } from "@/components/ui/LabMoreButton";
import { REDEV_STAGES, type ComplexRedev, type RedevProject } from "@/lib/redev/read";

async function fetchRedev(complexId: string): Promise<{ items: ComplexRedev[] }> {
  const res = await fetch(`/api/redev/complex/${complexId}`);
  if (!res.ok) return { items: [] };
  return res.json();
}

function dot(d: string | null): string {
  return d ? d.slice(0, 7).replace("-", ".") : "—";
}

/** 8단계 막대 — 지난 단계 청록, 현재 단계 진한 청록, 남은 단계 회색 */
function StageBar({ index }: { index: number }) {
  return (
    <div className="flex gap-1" aria-hidden>
      {REDEV_STAGES.map((s, i) => (
        <span
          key={s}
          className="h-2 flex-1 rounded-full"
          style={{
            background:
              i < index ? "var(--lab-brand-border)" : i === index ? "var(--lab-brand-primary)" : "var(--lab-surface-subtle)",
          }}
        />
      ))}
    </div>
  );
}

function ProjectCard({ project, zoneName }: { project: RedevProject; zoneName: string }) {
  const [open, setOpen] = useState(false);
  const next = project.stageIndex >= 0 && project.stageIndex < REDEV_STAGES.length - 1 ? REDEV_STAGES[project.stageIndex + 1] : null;
  const current = project.dates.find((d) => d.stage === project.stage);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <LabTag tone="brand">{project.kind === "기타" ? (project.projectType ?? "정비사업") : project.kind}</LabTag>
          {project.publicPrivate ? <LabTag>{project.publicPrivate}</LabTag> : null}
          {project.districtType && project.districtType !== "일반" ? <LabTag>{project.districtType}</LabTag> : null}
        </div>
        <p className="detail-data-value-emphasis break-keep">{project.zoneName}</p>
        {zoneName !== project.zoneName ? <p className="detail-meta break-keep">{zoneName}</p> : null}
      </div>

      <div className="flex flex-col gap-2">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[20px] font-bold leading-7 text-[color:var(--lab-teal-700)]">{project.stage ?? "단계 정보 없음"}</span>
          {current?.date ? <span className="detail-meta tabular-nums">{dot(current.date)}</span> : null}
          {next ? <span className="detail-meta">다음: {next}</span> : null}
        </p>
        {project.stageIndex >= 0 ? <StageBar index={project.stageIndex} /> : null}
        <div className="flex justify-between detail-meta" aria-hidden>
          <span>{REDEV_STAGES[0]}</span>
          <span>{REDEV_STAGES[REDEV_STAGES.length - 1]}</span>
        </div>
      </div>

      {project.householdsBefore != null || project.householdsTotal != null ? (
        <dl className="grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-[color:var(--lab-border)] px-3 py-2">
            <dt className="detail-label">지금</dt>
            <dd className="detail-data-value-emphasis tabular-nums">
              {project.householdsBefore != null ? `${project.householdsBefore.toLocaleString("ko-KR")}세대` : "—"}
            </dd>
          </div>
          <div className="rounded-xl border border-[color:var(--lab-border)] px-3 py-2">
            <dt className="detail-label">새로 짓는 세대</dt>
            <dd className="detail-data-value-emphasis tabular-nums">
              {project.householdsTotal != null ? `${project.householdsTotal.toLocaleString("ko-KR")}세대` : "—"}
            </dd>
            {project.householdsSale != null || project.householdsRent != null ? (
              <dd className="detail-meta tabular-nums">
                분양 {(project.householdsSale ?? 0).toLocaleString("ko-KR")} · 임대 {(project.householdsRent ?? 0).toLocaleString("ko-KR")}
              </dd>
            ) : null}
          </div>
        </dl>
      ) : null}

      {open ? (
        <ol className="flex flex-col divide-y divide-[color:var(--lab-border)]">
          {project.dates.map((d, i) => (
            <li key={d.stage} className="flex items-center justify-between py-2">
              <span
                className={i === project.stageIndex ? "detail-data-value-emphasis text-[color:var(--lab-teal-700)]" : "detail-body"}
              >
                {d.stage}
              </span>
              <span className="detail-meta tabular-nums">{dot(d.date)}</span>
            </li>
          ))}
        </ol>
      ) : null}
      <LabMoreButton expanded={open} onToggle={() => setOpen((v) => !v)} label="단계별 날짜 보기" />
    </div>
  );
}

/**
 * 단지 상세 — 이 단지가 들어간 서울 정비구역(재건축·재개발)과 사업 단계.
 * 사업 단계가 이어진 구역이 없으면 구역 이름만, 구역도 없으면 섹션을 그리지 않는다.
 */
export function ComplexRedevSection({ complexId }: { complexId: string }) {
  const query = useQuery({
    queryKey: ["complex-redev", complexId],
    queryFn: () => fetchRedev(complexId),
    staleTime: 60 * 60 * 1000,
  });
  const items = query.data?.items ?? [];
  if (!items.length) return null;
  const withProject = items.filter((x) => x.project);
  const baseDate = withProject[0]?.project?.baseDate;
  return (
    <LabSection
      id="section-redev"
      title="정비사업"
      meta={baseDate ? `${baseDate.slice(0, 7).replace("-", ".")} 기준` : undefined}
      tip={
        <p>
          서울시 정비사업 추진현황과 서울시 도시계획 구역도(의제처리구역)를 이어 보여 줍니다. 단지 위치가 구역 안에 들어간
          경우만 표시합니다.
        </p>
      }
    >
      {withProject.length ? (
        withProject.map((x) => <ProjectCard key={x.project!.code} project={x.project!} zoneName={x.zone.name} />)
      ) : (
        <div className="flex flex-col gap-1">
          {items.map((x) => (
            <p key={x.zone.zoneId} className="detail-body break-keep">
              <span className="font-semibold">{x.zone.name}</span>
              {x.zone.category ? <span className="detail-meta"> · {x.zone.category}</span> : null}
            </p>
          ))}
          <p className="detail-meta">사업 단계 정보는 아직 없습니다.</p>
        </div>
      )}
    </LabSection>
  );
}
