"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LabCard, LabSectionHeading } from "@/components/ui/lab";
import { LabDisclosure } from "@/components/ui/LabDisclosure";
import { LabTabs } from "@/components/ui/LabTabs";
import {
  schoolLevelLabel,
  type NearbySchool,
  type SchoolLevel,
  type SchoolPilotStatus,
} from "@/lib/complex-detail/neis";

type CatchmentPayload = {
  decision: "VERIFIED" | "HOLD";
  candidateSchoolName: string;
  evidence: string;
  neededSources: string[];
};

type SchoolsResponse = {
  status: SchoolPilotStatus | string;
  reason: string;
  assignmentSupported: boolean;
  schools: NearbySchool[];
  catchment: CatchmentPayload | null;
  attribution: string | null;
  distanceBasis: string | null;
  dataAsOf: string | null;
};

const LEVEL_TABS = [
  { id: "elementary" as const, label: "초등학교" },
  { id: "middle" as const, label: "중학교" },
  { id: "high" as const, label: "고등학교" },
];

async function loadSchools(aptName: string): Promise<SchoolsResponse> {
  const qs = new URLSearchParams({ aptName });
  const res = await fetch(`/api/complex-schools?${qs}`);
  if (!res.ok) {
    return {
      status: "API_ERROR",
      reason: "학군 정보를 불러오지 못했습니다.",
      assignmentSupported: false,
      schools: [],
      catchment: null,
      attribution: null,
      distanceBasis: null,
      dataAsOf: null,
    };
  }
  return res.json();
}

function statusMessage(status: string, reason: string): string {
  switch (status) {
    case "API_ERROR":
      return reason || "학교 정보를 불러오지 못했습니다.";
    case "NO_RESULTS":
      return reason || "조회 결과가 없습니다.";
    case "PILOT_ONLY":
      return reason || "이 단지는 학군 pilot 대상이 아닙니다.";
    case "CATCHMENT_UNVERIFIED":
    case "SUCCESS":
      return "";
    default:
      return reason || "학군 데이터를 표시할 수 없습니다.";
  }
}

/** Inline 학군 — nearby NEIS data for 잠실엘스; never claims official assignment. */
export function ComplexSchoolsSection({ aptName }: { aptName: string }) {
  const [level, setLevel] = useState<SchoolLevel>("elementary");
  const q = useQuery({
    queryKey: ["complex-schools", aptName],
    queryFn: () => loadSchools(aptName),
    staleTime: 60 * 60 * 1000,
    retry: 0,
  });

  const schoolsForLevel = useMemo(() => {
    const list = q.data?.schools ?? [];
    return list.filter((s) => s.level === level);
  }, [q.data?.schools, level]);

  const status = q.data?.status ?? "";
  const showList = status === "CATCHMENT_UNVERIFIED" || status === "SUCCESS";

  return (
    <LabCard className="detail-card">
      <LabSectionHeading title="학군" description="인근 학교 정보" />

      <div className="mt-3">
        <LabTabs
          items={LEVEL_TABS}
          value={level}
          onChange={setLevel}
          ariaLabel="학교급"
          variant="primary"
        />
      </div>

      {q.isLoading ? (
        <p className="mt-3 text-sm text-slate-500">학군 정보를 불러오는 중…</p>
      ) : null}

      {!q.isLoading && !showList ? (
        <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-3">
          <p className="text-sm text-slate-600">
            {statusMessage(status, q.data?.reason ?? "")}
          </p>
          {status === "NO_RESULTS" || status === "API_ERROR" ? (
            <p className="mt-1 text-[12px] leading-relaxed text-slate-400">
              학교 없음으로 단정하지 않습니다. 상태: {status}
            </p>
          ) : null}
        </div>
      ) : null}

      {showList ? (
        <div className="mt-3 space-y-3">
          {level === "elementary" ? (
            <p className="text-[12px] leading-relaxed text-slate-500">
              공식 통학구역은 아직 확인되지 않아 배정학교로 표시하지 않습니다.
              아래는 인근 초등학교입니다.
            </p>
          ) : (
            <p className="text-[12px] leading-relaxed text-slate-500">
              {schoolLevelLabel(level)}는 배정 의미를 두지 않고 인근 학교만
              표시합니다.
            </p>
          )}

          <div className="space-y-1">
            <p className="text-[11px] font-medium text-slate-500">
              인근 {schoolLevelLabel(level)}
            </p>
            {schoolsForLevel.length === 0 ? (
              <p className="py-2 text-sm text-slate-500">
                이 학교급 인근 결과가 없습니다.
              </p>
            ) : (
              schoolsForLevel.map((school) => (
                <SchoolRow
                  key={`${school.level}-${school.name}`}
                  school={school}
                />
              ))
            )}
          </div>

          <LabDisclosure title="학교 정보 기준 보기" className="mt-2">
            <dl className="space-y-2 text-sm text-slate-700">
              <div>
                <dt className="text-[11px] font-medium text-slate-500">
                  학교정보 출처
                </dt>
                <dd className="mt-0.5">
                  {q.data?.attribution ?? "NEIS 교육정보개방포털"}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium text-slate-500">
                  통학구역 출처
                </dt>
                <dd className="mt-0.5">
                  {q.data?.catchment?.decision === "VERIFIED"
                    ? "공식 통학구역 확인됨"
                    : "미확인 (표시 보류)"}
                </dd>
              </div>
              {q.data?.catchment?.decision === "HOLD" ? (
                <div>
                  <dt className="text-[11px] font-medium text-slate-500">
                    통학구역 보류 사유
                  </dt>
                  <dd className="mt-0.5 leading-relaxed">
                    {q.data.catchment.evidence}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt className="text-[11px] font-medium text-slate-500">
                  거리 기준
                </dt>
                <dd className="mt-0.5">
                  {q.data?.distanceBasis ??
                    "직선거리만 사용. 도보시간·도보거리 추정 없음."}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium text-slate-500">
                  데이터 기준일
                </dt>
                <dd className="mt-0.5">{q.data?.dataAsOf ?? "—"}</dd>
              </div>
            </dl>
          </LabDisclosure>
        </div>
      ) : null}
    </LabCard>
  );
}

function SchoolRow({ school }: { school: NearbySchool }) {
  const meta = [school.foundation, school.distanceLabel]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-100 py-2.5 last:border-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-900">
          {school.name}
        </p>
        {meta ? (
          <p className="mt-0.5 text-[11px] text-slate-400">{meta}</p>
        ) : null}
      </div>
    </div>
  );
}
