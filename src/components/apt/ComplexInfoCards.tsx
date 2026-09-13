"use client";

import { LabCard, LabSectionHeading } from "@/components/ui/lab";
import {
  formatApprovalYearLabel,
  type ComplexDetailV1,
} from "@/lib/complex-detail/get-complex-detail-v1";

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 py-2.5 last:border-0">
      <dt className="shrink-0 text-sm text-slate-500">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-medium tabular-nums text-slate-900">
        {value}
      </dd>
    </div>
  );
}

function basicRows(
  detail: ComplexDetailV1,
): Array<{ label: string; value: string }> {
  const basic = detail.basic;
  if (!basic) return [];
  const rows: Array<{ label: string; value: string }> = [];
  // 세대수·동수·준공은 헤더 chips에 두고, 단지 정보는 생활 유용 필드만.
  if (basic.heatingType) rows.push({ label: "난방방식", value: basic.heatingType });
  if (basic.managementType) {
    rows.push({ label: "관리방식", value: basic.managementType });
  }
  if (basic.parkingTotal != null && basic.parkingTotal > 0) {
    const per =
      basic.parkingPerHousehold != null && basic.parkingPerHousehold > 0
        ? ` (세대당 ${Number(basic.parkingPerHousehold).toFixed(1)})`
        : "";
    rows.push({
      label: "주차",
      value: `${basic.parkingTotal.toLocaleString("ko-KR")}대${per}`,
    });
  }
  return rows;
}

function buildingRows(
  detail: ComplexDetailV1,
): Array<{ label: string; value: string }> {
  const building = detail.building;
  if (!building) return [];
  const rows: Array<{ label: string; value: string }> = [];
  if (building.maxFloor != null && building.maxFloor > 0) {
    rows.push({ label: "최고층", value: `${building.maxFloor}층` });
  }
  if (building.structureType) {
    rows.push({ label: "구조", value: building.structureType });
  }
  if (building.mainPurpose) {
    rows.push({ label: "주용도", value: building.mainPurpose });
  }
  return rows;
}

export function ComplexBasicInfoCard({ detail }: { detail: ComplexDetailV1 }) {
  const rows = basicRows(detail);
  if (rows.length === 0) return null;
  return (
    <LabCard className="p-4 sm:p-5">
      <LabSectionHeading title="단지 정보" />
      <dl className="mt-3">
        {rows.map((r) => (
          <InfoRow key={r.label} label={r.label} value={r.value} />
        ))}
      </dl>
    </LabCard>
  );
}

export function ComplexBuildingInfoCard({
  detail,
}: {
  detail: ComplexDetailV1;
}) {
  const rows = buildingRows(detail);
  if (rows.length === 0) return null;
  return (
    <LabCard className="p-4 sm:p-5">
      <LabSectionHeading title="건축 정보" />
      <dl className="mt-3">
        {rows.map((r) => (
          <InfoRow key={r.label} label={r.label} value={r.value} />
        ))}
      </dl>
    </LabCard>
  );
}

/** Plain header metadata — omit empty values. FAR/BCR here; heating in 단지 정보. */
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

