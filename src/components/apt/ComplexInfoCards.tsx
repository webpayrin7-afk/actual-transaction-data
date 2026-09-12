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
  if (basic.householdCount != null && basic.householdCount > 0) {
    rows.push({
      label: "세대수",
      value: `${basic.householdCount.toLocaleString("ko-KR")}세대`,
    });
  }
  if (basic.buildingCount != null && basic.buildingCount > 0) {
    rows.push({
      label: "동수",
      value: `${basic.buildingCount.toLocaleString("ko-KR")}개동`,
    });
  }
  const yearLabel = formatApprovalYearLabel(basic.approvalDate);
  if (yearLabel) rows.push({ label: "준공", value: yearLabel });
  if (basic.heatingType) rows.push({ label: "난방", value: basic.heatingType });
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
  if (building.farRatio != null && building.farRatio > 0) {
    rows.push({ label: "용적률", value: `${building.farRatio}%` });
  }
  if (building.bcrRatio != null && building.bcrRatio > 0) {
    rows.push({ label: "건폐율", value: `${building.bcrRatio}%` });
  }
  return rows;
}

export function ComplexBasicInfoCard({ detail }: { detail: ComplexDetailV1 }) {
  const rows = basicRows(detail);
  if (rows.length === 0) return null;
  return (
    <LabCard className="p-4 sm:p-5">
      <LabSectionHeading title="단지 정보" />
      <dl className="mt-2">
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
      <dl className="mt-2">
        {rows.map((r) => (
          <InfoRow key={r.label} label={r.label} value={r.value} />
        ))}
      </dl>
    </LabCard>
  );
}

/** Header meta chips — omit empty values. */
export function complexHeaderChips(detail: ComplexDetailV1 | null): string[] {
  if (!detail?.basic) return [];
  const chips: string[] = [];
  const { householdCount, buildingCount, approvalDate, heatingType } =
    detail.basic;
  if (householdCount != null && householdCount > 0) {
    chips.push(`${householdCount.toLocaleString("ko-KR")}세대`);
  }
  if (buildingCount != null && buildingCount > 0) {
    chips.push(`${buildingCount.toLocaleString("ko-KR")}개동`);
  }
  const year = formatApprovalYearLabel(approvalDate);
  if (year) chips.push(year);
  if (heatingType) chips.push(heatingType);
  return chips;
}
