/**
 * 평형 묶기 — 실거래 전용면적은 같은 타입이라도 호마다 소수 둘째 자리가 조금씩 다르게 신고된다
 * (예: 원베일리 34평 = 전용 84.92~84.99㎡ 8가지). 이걸 한 줄씩 두면 목록이 길고 표본이 쪼개지므로
 * 가까운 전용면적(이웃 간격 0.5㎡ 미만, 폭 1㎡ 미만)을 한 평형으로 묶는다.
 * 실거래엔 공급면적이 없어 같은 전용을 공급으로 다시 가르지는 않는다(추정 금지).
 *
 * 묶인 옵션의 key는 "84.92-84.99" — key만으로 거를 범위를 알 수 있어, 면적 목록 없이 받는 요청(다음 페이지)도 같게 거른다.
 */
import type { AptAreaOption } from "@/lib/molit/apt-client";
import { normalizeAreaKey } from "@/lib/apt/default-area";

const NEIGHBOR_GAP = 0.5;
const MAX_SPAN = 1;

const RANGE_KEY = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/;

export function areaRangeKey(min: number, max: number): string {
  return `${normalizeAreaKey(min)}-${normalizeAreaKey(max)}`;
}

/** "84.92-84.99" → 범위. 묶인 평형 key가 아니면 null */
export function parseAreaRangeKey(key: string): { min: number; max: number } | null {
  const m = RANGE_KEY.exec(key.trim());
  if (!m) return null;
  const min = Number(m[1]);
  const max = Number(m[2]);
  return Number.isFinite(min) && Number.isFinite(max) && min <= max ? { min, max } : null;
}

/** 전용면적이 이 평형 옵션에 들어가는지 */
export function areaOptionContains(area: AptAreaOption, sqm: number): boolean {
  if (area.exclusiveAreaMin != null && area.exclusiveAreaMax != null) {
    return sqm >= area.exclusiveAreaMin - 0.005 && sqm <= area.exclusiveAreaMax + 0.005;
  }
  return normalizeAreaKey(sqm) === normalizeAreaKey(area.exclusiveArea);
}

/**
 * 예전 링크의 key("84.98")를 지금 목록의 key로 — 그 전용이 들어간 묶음 평형으로 옮긴다. 못 찾으면 null.
 */
export function resolveAreaKeyAlias(key: string, areas: AptAreaOption[]): string | null {
  if (!key) return null;
  if (key === "all" || areas.some((a) => a.key === key)) return key;
  const range = parseAreaRangeKey(key);
  const sqm = range ? (range.min + range.max) / 2 : Number(key);
  if (!Number.isFinite(sqm)) return null;
  return areas.find((a) => areaOptionContains(a, sqm))?.key ?? null;
}

function sameOrNull<T>(values: Array<T | null | undefined>): T | null {
  const set = new Set(values.filter((v): v is T => v != null));
  return set.size === 1 ? [...set][0]! : null;
}

/** 전용면적별 옵션을 평형 묶음으로. 시범 단지의 market_group 옵션이 있으면 그대로 둔다. */
export function groupAreaOptions(areas: AptAreaOption[]): AptAreaOption[] {
  if (areas.length <= 1 || areas.some((a) => a.selectorKind === "market_group")) return areas;
  const sorted = [...areas].sort((a, b) => a.exclusiveArea - b.exclusiveArea);
  const groups: AptAreaOption[][] = [];
  for (const area of sorted) {
    const cur = groups[groups.length - 1];
    const prev = cur?.[cur.length - 1];
    if (
      cur &&
      prev &&
      area.exclusiveArea - prev.exclusiveArea < NEIGHBOR_GAP &&
      area.exclusiveArea - cur[0]!.exclusiveArea < MAX_SPAN
    ) {
      cur.push(area);
    } else {
      groups.push([area]);
    }
  }
  return groups.map((members) => {
    if (members.length === 1) return members[0]!;
    const min = members[0]!.exclusiveArea;
    const max = members[members.length - 1]!.exclusiveArea;
    const supplyMins = members.map((m) => m.supplyAreaMin).filter((v): v is number => v != null && v > 0);
    const supplyMaxs = members.map((m) => m.supplyAreaMax).filter((v): v is number => v != null && v > 0);
    return {
      key: areaRangeKey(min, max),
      label: `${normalizeAreaKey(min)}~${normalizeAreaKey(max)}㎡`,
      exclusiveArea: min,
      count: members.reduce((s, m) => s + m.count, 0),
      selectorKind: "market_group" as const,
      exclusiveAreaMin: min,
      exclusiveAreaMax: max,
      supplyAreaMin: supplyMins.length ? Math.min(...supplyMins) : null,
      supplyAreaMax: supplyMaxs.length ? Math.max(...supplyMaxs) : null,
      marketLabel: sameOrNull(members.map((m) => m.marketLabel)),
      secondaryLabel: null,
    };
  });
}
