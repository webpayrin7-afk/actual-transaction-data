import type { StatsScope } from "@/lib/market/keys";

/**
 * /stats 시·도(metro) 선택 옵션.
 * value는 기존 API scope와 동일. 향후 지원 시도만 enabled로 추가하면 된다.
 */
export type StatsRegionOption = {
  value: StatsScope | string;
  label: string;
  /** false면 UI에 노출하지 않음 (향후 예약) */
  enabled: boolean;
};

/**
 * 현재 활성화된 시·도만 enabled.
 * 인천·부산 등은 enabled:false로 남겨 두지 않고 — 스펙상 미지원 옵션은
 * 목록에 넣지 않는다. 추가 시 이 배열에 { value, label, enabled: true }만 추가.
 */
export const STATS_REGION_OPTIONS: StatsRegionOption[] = [
  { value: "all", label: "전국", enabled: true },
  { value: "seoul", label: "서울", enabled: true },
  { value: "gyeonggi", label: "경기", enabled: true },
  // 향후 예:
  // { value: "incheon", label: "인천", enabled: true },
  // { value: "busan", label: "부산", enabled: true },
];

export function enabledStatsRegions(): StatsRegionOption[] {
  return STATS_REGION_OPTIONS.filter((o) => o.enabled);
}

export function statsRegionLabel(scope: string): string {
  return (
    STATS_REGION_OPTIONS.find((o) => o.value === scope)?.label ?? "전국"
  );
}

/** URL/UI용: 현재 enabled 옵션에 있는 scope만 유효. 시도 추가 시 배열만 갱신. */
export function isStatsScope(v: string | null): v is StatsScope {
  if (!v) return false;
  return enabledStatsRegions().some((o) => o.value === v);
}
