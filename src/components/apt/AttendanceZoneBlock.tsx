"use client";

import { ChevronRight } from "lucide-react";
import type {
  ProductAttendanceSchool,
  ProductAttendanceZone,
} from "@/lib/complex-detail/attendance-zone";

/**
 * 배정 초등학교 (공식 통학구역 — 인근 학교 목록과 별개).
 * 학교 코드가 이어진 학교만 눌러서 학교 상세로. 도보 시간은 단지 걷기 경로에 그 학교가 있을 때만.
 */
export function AttendanceZoneBlock({
  zone,
  onOpenSchool,
}: {
  zone: ProductAttendanceZone;
  onOpenSchool: (s: {
    schoolCode: string | null;
    name: string;
    level: string;
    address: string | null;
  }) => void;
}) {
  const joint = zone.jointSchools ?? [];
  const jointZoneName = zone.jointZoneName ?? null;
  if (!zone.designatedSchools.length && !joint.length && !jointZoneName) {
    return null;
  }

  const school = (m: ProductAttendanceSchool) => {
    const label = (
      <>
        <span className="font-medium text-slate-800">{m.name}</span>
        {m.walkMin != null ? (
          <span className="text-slate-500">{` · 도보 ${m.walkMin}분`}</span>
        ) : null}
      </>
    );
    if (!m.detailLinkable) {
      return <span key={`az-${m.schoolCode ?? m.name}`}>{label}</span>;
    }
    return (
      <button
        key={`az-${m.schoolCode ?? m.name}`}
        type="button"
        onClick={() =>
          onOpenSchool({
            schoolCode: m.schoolCode,
            name: m.name,
            level: "elementary",
            address: m.roadAddress,
          })
        }
        aria-label={`${m.name} 상세 보기`}
        className="inline-flex items-center gap-0.5 text-left hover:underline"
      >
        {label}
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
      </button>
    );
  };

  return (
    <div
      className="rounded-lg bg-slate-50 px-3 py-2"
      data-testid="attendance-zone-block"
      data-zone-id={zone.id}
      data-zone-kind={zone.zoneKind}
    >
      {zone.designatedSchools.length ? (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[14px] leading-6">
          <span className="shrink-0 text-slate-500">배정 초등학교</span>
          {zone.designatedSchools.map(school)}
        </div>
      ) : null}
      {joint.length || jointZoneName ? (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[14px] leading-6">
          <span className="shrink-0 text-slate-500">공동통학구역</span>
          {joint.length ? (
            joint.map(school)
          ) : (
            <span className="font-medium text-slate-800">{jointZoneName}</span>
          )}
        </div>
      ) : null}
      {zone.note ? (
        <p className="mt-1 text-[12px] leading-5 text-slate-500">{zone.note}</p>
      ) : null}
      {zone.attributionLabel ? (
        <p className="text-[12px] leading-5 text-slate-400">
          {`출처: ${zone.attributionLabel}`}
        </p>
      ) : null}
    </div>
  );
}
