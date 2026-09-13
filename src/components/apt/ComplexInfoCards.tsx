"use client";

import { LabCard, LabSectionHeading } from "@/components/ui/lab";
import {
  formatApprovalYearLabel,
  type ComplexDetailV1,
} from "@/lib/complex-detail/get-complex-detail-v1";

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 py-2.5 last:border-0 sm:block sm:border-0 sm:py-0">
      <dt className="shrink-0 text-[13px] text-slate-500 sm:text-sm">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-medium tabular-nums text-slate-900 sm:mt-1 sm:text-left sm:text-[15px]">
        {value}
      </dd>
    </div>
  );
}

/**
 * Deeper residential/building characteristics for the unified 단지 정보 section.
 * Excludes header identity facts: 세대수 · 동수 · 준공 · 용적률 · 건폐율.
 */
export function complexInfoRows(
  detail: ComplexDetailV1,
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const basic = detail.basic;
  const building = detail.building;

  if (basic?.heatingType) {
    rows.push({ label: "난방방식", value: basic.heatingType });
  }
  if (basic?.managementType) {
    rows.push({ label: "관리방식", value: basic.managementType });
  }
  if (basic?.parkingTotal != null && basic.parkingTotal > 0) {
    rows.push({
      label: "주차대수",
      value: `${basic.parkingTotal.toLocaleString("ko-KR")}대`,
    });
  }
  if (basic?.parkingPerHousehold != null && basic.parkingPerHousehold > 0) {
    rows.push({
      label: "세대당 주차",
      value: `${Number(basic.parkingPerHousehold).toLocaleString("ko-KR", {
        maximumFractionDigits: 2,
      })}대`,
    });
  }
  if (building?.maxFloor != null && building.maxFloor > 0) {
    rows.push({ label: "최고층", value: `${building.maxFloor}층` });
  }
  if (building?.structureType) {
    rows.push({ label: "건축구조", value: building.structureType });
  }
  if (building?.mainPurpose) {
    rows.push({ label: "주용도", value: building.mainPurpose });
  }
  return rows;
}

export function hasComplexInfoSection(detail: ComplexDetailV1 | null): boolean {
  if (!detail) return false;
  return complexInfoRows(detail).length > 0;
}

/** Single consolidated LAB white section — 단지 정보 (basic + building, no header dupes). */
export function ComplexInfoCard({ detail }: { detail: ComplexDetailV1 }) {
  const rows = complexInfoRows(detail);
  if (rows.length === 0) return null;
  return (
    <LabCard className="p-4 sm:p-5">
      <LabSectionHeading title="단지 정보" />
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:mt-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((r) => (
          <InfoRow key={r.label} label={r.label} value={r.value} />
        ))}
      </dl>
    </LabCard>
  );
}

/** @deprecated Prefer ComplexInfoCard — kept for any residual imports. */
export function ComplexBasicInfoCard({ detail }: { detail: ComplexDetailV1 }) {
  return <ComplexInfoCard detail={detail} />;
}

/** @deprecated Prefer ComplexInfoCard — standalone 건축 정보 removed in Phase 7.7. */
export function ComplexBuildingInfoCard(_props: {
  detail: ComplexDetailV1;
}) {
  return null;
}

/**
 * Plain-text header metadata (no chips/pills).
 * 세대수 · 동수 · 준공 · 용적률 · 건폐율 — omit nulls entirely.
 */
export function complexHeaderChips(detail: ComplexDetailV1 | null): string[] {
  if (!detail) return [];
  const chips: string[] = [];
  const basic = detail.basic;
  const building = detail.building;
  if (basic?.householdCount != null && basic.householdCount > 0) {
    chips.push(`${basic.householdCount.toLocaleString("ko-KR")}세대`);
  }
  if (basic?.buildingCount != null && basic.buildingCount > 0) {
    chips.push(`${basic.buildingCount.toLocaleString("ko-KR")}개동`);
  }
  const year = formatApprovalYearLabel(basic?.approvalDate ?? null);
  if (year) chips.push(year);
  if (building?.farRatio != null && building.farRatio > 0) {
    chips.push(`용적률 ${building.farRatio}%`);
  }
  if (building?.bcrRatio != null && building.bcrRatio > 0) {
    chips.push(`건폐율 ${building.bcrRatio}%`);
  }
  return chips;
}
