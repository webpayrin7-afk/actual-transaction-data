import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST } from "@/components/ui/LabListRow";
import type { ComplexDetailV1 } from "@/lib/complex-detail/get-complex-detail-v1";
import { formatParkingPerHouseholdLabel } from "@/lib/complex-detail/hero-meta";

function distanceLabel(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m}m`;
}

/**
 * 단지 정보 — 헤더 라벨에 다 싣지 못하는 건물·주거 조건을 라벨·값 행으로 (학교 상세 기본정보와 같은 형식).
 * 값이 있는 항목만 보여주고, 추정하지 않는다.
 */
export function ComplexInfoSection({ detail }: { detail: ComplexDetailV1 | null }) {
  if (!detail) return null;
  const basic = detail.basic;
  const building = detail.building;
  const address = detail.identity?.roadAddress ?? null;
  const school = detail.nearestElementary ?? null;

  const rows: Array<{ label: string; value: string }> = [];
  if (address) rows.push({ label: "도로명 주소", value: address });
  if (basic?.parkingPerHousehold != null && basic.parkingPerHousehold > 0) {
    const total = basic.parkingTotal ? ` (총 ${basic.parkingTotal.toLocaleString("ko-KR")}대)` : "";
    rows.push({ label: "주차", value: `${formatParkingPerHouseholdLabel(basic.parkingPerHousehold).replace(/^주차\s*/, "")}${total}` });
  }
  if (basic?.heatingType) rows.push({ label: "난방", value: basic.heatingType });
  if (basic?.managementType) rows.push({ label: "관리 방식", value: basic.managementType });
  if (building?.structureType) rows.push({ label: "구조", value: building.structureType });
  if (school) {
    rows.push({ label: "가까운 초등학교", value: `${school.schoolName} · 직선 ${distanceLabel(school.distanceM)}` });
  }
  if (rows.length === 0) return null;

  return (
    <LabSection id="section-info" title="단지 정보" meta="건축물대장 등 공공데이터">
      <dl className={LAB_LIST}>
        {rows.map((r) => (
          <div key={r.label} className="flex min-h-11 items-center justify-between gap-4 py-2">
            <dt className="detail-label shrink-0">{r.label}</dt>
            <dd className="detail-data-value min-w-0 text-right break-words">{r.value}</dd>
          </div>
        ))}
      </dl>
    </LabSection>
  );
}
