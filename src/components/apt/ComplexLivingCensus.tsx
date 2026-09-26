"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FacilityIcon, ComplexCommercePreparing } from "@/components/apt/ComplexCommerceSection";
import { LabSubsectionHeader } from "@/components/ui/LabSection";
import { LabTabs } from "@/components/ui/LabTabs";
import {
  COMMERCE_FACILITY_CATEGORY,
  COMMERCE_CATEGORY_CSS_VAR,
  commerceCategoryColor,
} from "@/lib/complex-detail/commerce-category-colors";
import type { CommerceFacilities } from "@/lib/complex-detail/commerce-snapshot";
import type {
  LivingCensus,
  LivingCensusFacilityKey,
  LivingCensusRadius,
} from "@/lib/complex-detail/living-census";
import { LabDataLoading } from "@/components/ui/LabLoading";

/** Census key → pilot facility key (icon + category color only; counts are the census's own). */
const FACILITIES: Array<{
  key: LivingCensusFacilityKey;
  pilotKey: keyof CommerceFacilities;
  label: string;
}> = [
  { key: "MEDICAL", pilotKey: "병원/의원", label: "의료기관" },
  { key: "PHARMACY", pilotKey: "약국", label: "약국" },
  { key: "CONVENIENCE", pilotKey: "편의점", label: "편의점" },
  { key: "GROCERY", pilotKey: "마트/슈퍼", label: "마트·슈퍼" },
  { key: "CAFE", pilotKey: "카페", label: "카페" },
  { key: "FOOD", pilotKey: "음식점", label: "식음업소" },
  { key: "SPORTS", pilotKey: "체육", label: "체육" },
];

const FOOD_LABEL: Record<string, string> = {
  KOREAN: "한식",
  CASUAL_OTHER: "간이음식·기타",
  BAR: "주점",
  JAPANESE: "일식",
  WESTERN: "양식",
  CHINESE: "중식",
  CAFETERIA_BUFFET: "구내식당·뷔페",
  SOUTHEAST_ASIAN: "동남아식",
  OTHER: "기타",
};

const MEDICAL_LABEL: Record<string, string> = {
  DENTAL: "치과의원",
  KOREAN_MEDICINE: "한의원",
  INTERNAL_PEDIATRIC: "내과·소아과",
  DERM_UROLOGY: "피부·비뇨기과",
  NEURO_PSYCHIATRY: "신경·정신과",
  SURGERY: "외과·정형외과",
  ENT: "이비인후과",
  OBGYN: "산부인과",
  PLASTIC_SURGERY: "성형외과",
  OPHTHALMOLOGY: "안과",
  HOSPITAL_DENTAL: "치과병원",
  RADIOLOGY_LAB: "영상·검사",
  HOSPITAL: "병원",
  HOSPITAL_KOREAN: "한방병원",
  HOSPITAL_NURSING: "요양병원",
  OTHER: "기타 의원",
};

const RANK_LIMIT = 5;

function RankList({
  items,
  labels,
  color,
}: {
  items: Array<{ key: string; count: number }>;
  labels: Record<string, string>;
  color: string;
}) {
  const top = items.slice(0, RANK_LIMIT);
  const max = Math.max(...top.map((i) => i.count), 1);
  return (
    <ol className="space-y-2.5">
      {top.map((item, idx) => (
        <li key={item.key} className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="detail-meta w-4 shrink-0 font-semibold tabular-nums">{idx + 1}</span>
            <span className="detail-label min-w-0 flex-1 truncate text-[color:var(--lab-navy-950)]">
              {labels[item.key] ?? item.key}
            </span>
            <span className="detail-label shrink-0 font-medium tabular-nums text-[color:var(--lab-navy-950)]">
              {item.count.toLocaleString("ko-KR")}
            </span>
          </div>
          <div
            className="ml-6 mt-1 h-1.5 overflow-hidden rounded-full bg-[color:var(--lab-surface-subtle)]"
            aria-hidden
          >
            <div
              className="h-full rounded-full"
              style={{ width: `${(item.count / max) * 100}%`, backgroundColor: color }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * 상권 탭 — 잠실엘스 파일럿 외 단지: SEMAS 생활시설 집계(complex_living_snapshots)를 그대로 보여준다.
 * 파일럿의 업종 구성·점 지도는 이 원천에 없으므로 만들지 않는다.
 */
export function ComplexLivingCensus({ complexId }: { complexId: string | null }) {
  const [radius, setRadius] = useState<LivingCensusRadius>(1000);
  const query = useQuery({
    queryKey: ["complex-living-census", complexId],
    queryFn: async (): Promise<{ status: string; census?: LivingCensus }> => {
      const res = await fetch(`/api/complex-living-census?complex_id=${complexId}`);
      if (!res.ok) throw new Error("living-census");
      return res.json();
    },
    enabled: Boolean(complexId),
    staleTime: 24 * 60 * 60 * 1000,
  });

  if (!complexId) return <ComplexCommercePreparing />;
  if (query.isLoading) return <LabDataLoading label="상권 불러오는 중" minHeight={160} />;
  const census = query.data?.census;
  if (!census) return <ComplexCommercePreparing />;

  const data = census.radii[radius];
  const total = FACILITIES.reduce((s, f) => s + data.facilities[f.key], 0);
  const asOf = census.sourceAsOf;
  const quarter = `${asOf.slice(0, 4)}년 ${Math.ceil(Number(asOf.slice(5, 7)) / 3)}분기`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="detail-meta">
          {quarter} · 소상공인시장진흥공단 · 직선거리
        </p>
        <LabTabs
          variant="compact"
          ariaLabel="반경"
          value={String(radius)}
          items={[
            { id: "500", label: "500m" },
            { id: "1000", label: "1km" },
          ]}
          onChange={(next) => setRadius(Number(next) as LivingCensusRadius)}
        />
      </div>

      <section className="flex flex-col gap-3">
        <LabSubsectionHeader
          title="주요 생활시설"
          meta={`반경 ${radius >= 1000 ? "1km" : "500m"} · ${total.toLocaleString("ko-KR")}곳`}
        />
        <div className="grid grid-cols-3 gap-x-2 gap-y-5 [@media(min-resolution:2dppx)_and_(max-width:360px)]:grid-cols-2">
          {FACILITIES.map(({ key, pilotKey, label }) => {
            const catKey = COMMERCE_FACILITY_CATEGORY[pilotKey];
            const color =
              catKey && catKey in COMMERCE_CATEGORY_CSS_VAR
                ? COMMERCE_CATEGORY_CSS_VAR[catKey]
                : "var(--lab-muted)";
            return (
              <div key={key} className="flex min-w-0 flex-col items-center px-1 text-center">
                <span
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md"
                  style={{ color, backgroundColor: commerceCategoryColor(catKey).soft }}
                >
                  <FacilityIcon keyName={pilotKey} />
                </span>
                <span className="detail-meta mt-1 truncate">{label}</span>
                <span className="detail-compact-value mt-0.5 leading-none tabular-nums">
                  {data.facilities[key].toLocaleString("ko-KR")}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      {data.food.length > 0 ? (
        <section className="detail-subsection-rule flex flex-col gap-3 pt-6">
          <LabSubsectionHeader title="음식점 구성" meta="상위 5개" />
          <RankList
            items={data.food}
            labels={FOOD_LABEL}
            color={COMMERCE_CATEGORY_CSS_VAR["음식/외식"] ?? "var(--lab-muted)"}
          />
        </section>
      ) : null}

      {data.medical.length > 0 ? (
        <section className="detail-subsection-rule flex flex-col gap-3 pt-6">
          <LabSubsectionHeader title="진료과목" meta="상위 5개" />
          <RankList
            items={data.medical}
            labels={MEDICAL_LABEL}
            color={COMMERCE_CATEGORY_CSS_VAR["의료/건강"] ?? "var(--lab-muted)"}
          />
        </section>
      ) : null}
    </div>
  );
}
