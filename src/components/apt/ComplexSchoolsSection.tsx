"use client";

import { useQuery } from "@tanstack/react-query";
import { LabCard, LabSectionHeading } from "@/components/ui/lab";
import {
  schoolLevelLabel,
  type NearbySchool,
  type SchoolLevel,
} from "@/lib/complex-detail/neis";

type SchoolsResponse = {
  status: string;
  reason: string;
  assignmentSupported: boolean;
  schools: NearbySchool[];
  attribution: string | null;
};

const LEVELS: SchoolLevel[] = ["elementary", "middle", "high"];

async function loadSchools(aptName: string): Promise<SchoolsResponse> {
  const qs = new URLSearchParams({ aptName });
  const res = await fetch(`/api/complex-schools?${qs}`);
  if (!res.ok) {
    return {
      status: "ERROR",
      reason: "학군 정보를 불러오지 못했습니다.",
      assignmentSupported: false,
      schools: [],
      attribution: null,
    };
  }
  return res.json();
}

/** Inline 학군 — nearby only; never claims official assignment. */
export function ComplexSchoolsSection({ aptName }: { aptName: string }) {
  const q = useQuery({
    queryKey: ["complex-schools", aptName],
    queryFn: () => loadSchools(aptName),
    staleTime: 60 * 60 * 1000,
    retry: 0,
  });

  const byLevel = new Map<SchoolLevel, NearbySchool>();
  for (const s of q.data?.schools ?? []) {
    if (!byLevel.has(s.level)) byLevel.set(s.level, s);
  }

  return (
    <LabCard className="p-4 sm:p-5">
      <LabSectionHeading
        title="학군"
        description="인근 학교 · 직선거리 (배정 학교 아님)"
      />

      {q.isLoading ? (
        <p className="mt-3 text-sm text-slate-500">학군 정보를 불러오는 중…</p>
      ) : null}

      {!q.isLoading && q.data?.status !== "READY" ? (
        <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-3">
          <p className="text-sm text-slate-600">
            학군 데이터를 아직 표시할 수 없습니다.
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-slate-400">
            {q.data?.reason || "DATA_SOURCE_NOT_READY"}
          </p>
          <p className="mt-2 text-[11px] text-slate-400">
            배정 학구가 아닌 인근 학교만 제공할 예정이며, 공식 배정 자료 없이는
            배정 여부를 표시하지 않습니다.
          </p>
        </div>
      ) : null}

      {q.data?.status === "READY" ? (
        <div className="mt-3 space-y-3">
          {LEVELS.map((level) => {
            const school = byLevel.get(level);
            return (
              <div
                key={level}
                className="flex items-start justify-between gap-3 border-b border-slate-100 pb-2.5 last:border-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-slate-500">
                    {schoolLevelLabel(level)}
                  </p>
                  <p className="mt-0.5 truncate text-sm font-medium text-slate-900">
                    {school?.name ?? "—"}
                  </p>
                  {school?.kind ? (
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      {school.kind}
                    </p>
                  ) : null}
                </div>
                <p className="shrink-0 text-sm tabular-nums text-slate-700">
                  {school?.distanceLabel ?? "—"}
                </p>
              </div>
            );
          })}
          <p className="text-[11px] text-slate-400">
            배정 학교가 아닙니다. 거리는 직선 기준입니다.
            {q.data.attribution ? ` · ${q.data.attribution}` : ""}
          </p>
        </div>
      ) : null}
    </LabCard>
  );
}
