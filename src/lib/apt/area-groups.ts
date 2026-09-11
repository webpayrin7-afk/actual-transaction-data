import type { AptAreaOption } from "@/lib/molit/apt";
import {
  buildAreaTradeStats,
  isArea84Band,
  normalizeAreaKey,
} from "@/lib/apt/default-area";

/**
 * 단지상세 면적 선택 그룹.
 *
 * 공급면적/계약면적/평형/주택형 필드는 현재 repo·DB·MOLIT 파서에 없음
 * (`excluUseAr` 전용면적만 존재). 외부 수집은 이 작업 범위 밖.
 *
 * → 공급면적 기준 grouping 불가. 전용면적 unique 분포 근접 clustering fallback.
 * → 전용㎡ 단순 floor/round를 그룹 ID로 쓰지 않음.
 * → 전용÷3.3 평형 추정 금지.
 * → exact areaKey(0.01㎡)는 members로 유지. 신고가(isSingoga)는 exact areaKey 기준 불변.
 */
export const HAS_SUPPLY_AREA_DATA = false;

/** 인접 unique 전용면적 간 최대 간격(㎡). 초과 시 새 그룹. */
export const CLUSTER_MAX_GAP_SQM = 1.25;

/** 한 그룹 전체 span 상한(㎡). 거리만으로 넓게 합치지 않음. */
export const CLUSTER_MAX_SPAN_SQM = 2.5;

export type AreaGroup = {
  /** 선택 값. 예: "g:59.82-60.98" */
  key: string;
  members: AptAreaOption[];
  count: number;
  minExclusiveArea: number;
  maxExclusiveArea: number;
  /** 공급면적 있을 때만. 현재는 항상 null. */
  supplyAreaMin: number | null;
  supplyAreaMax: number | null;
  /** 공급 평형명. 현재는 항상 null (추정 금지). */
  pyeongName: string | null;
};

type TradeLike = {
  dealType: string;
  exclusiveArea: number;
  dealDate: string;
};

function sortAreas(areas: AptAreaOption[]): AptAreaOption[] {
  return [...areas].sort((a, b) => {
    if (a.exclusiveArea !== b.exclusiveArea) {
      return a.exclusiveArea - b.exclusiveArea;
    }
    return a.key.localeCompare(b.key);
  });
}

export function areaGroupKeyFromMembers(members: AptAreaOption[]): string {
  const sorted = sortAreas(members);
  const min = normalizeAreaKey(sorted[0]!.exclusiveArea);
  const max = normalizeAreaKey(sorted[sorted.length - 1]!.exclusiveArea);
  return min === max ? `g:${min}` : `g:${min}-${max}`;
}

export function isAreaGroupKey(key: string): boolean {
  return /^g:[\d.]+(?:-[\d.]+)?$/.test(key);
}

/**
 * Unique 전용면적 정렬 후 인접 gap/span 기준 clustering.
 * floor/round로 그룹을 만들지 않음.
 */
export function buildAreaGroups(areas: AptAreaOption[]): AreaGroup[] {
  const sorted = sortAreas(areas);
  if (sorted.length === 0) return [];

  const clusters: AptAreaOption[][] = [];
  let current: AptAreaOption[] = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    const area = sorted[i]!;
    const prev = current[current.length - 1]!;
    const first = current[0]!;
    const gap = area.exclusiveArea - prev.exclusiveArea;
    const span = area.exclusiveArea - first.exclusiveArea;

    if (gap <= CLUSTER_MAX_GAP_SQM && span <= CLUSTER_MAX_SPAN_SQM) {
      current.push(area);
    } else {
      clusters.push(current);
      current = [area];
    }
  }
  clusters.push(current);

  return clusters.map((members) => {
    const sortedMembers = sortAreas(members);
    return {
      key: areaGroupKeyFromMembers(sortedMembers),
      members: sortedMembers,
      count: sortedMembers.reduce((sum, m) => sum + m.count, 0),
      minExclusiveArea: sortedMembers[0]!.exclusiveArea,
      maxExclusiveArea: sortedMembers[sortedMembers.length - 1]!.exclusiveArea,
      supplyAreaMin: null,
      supplyAreaMax: null,
      pyeongName: null,
    };
  });
}

/** 표시용 전용 정수 구간 (그룹핑 ID가 아님). 59.82~60.1 → 59~60 */
export function formatExclusiveRangeIntegers(
  minSqm: number,
  maxSqm: number,
): string {
  const lo = Math.floor(minSqm);
  const hi = Math.floor(maxSqm);
  if (lo === hi) return `${lo}`;
  return `${lo}~${hi}`;
}

function formatSupplyRange(min: number, max: number): string {
  const lo = Math.round(min);
  const hi = Math.round(max);
  if (lo === hi) return `${lo}`;
  return `${lo}~${hi}`;
}

/** 1순위 라벨: 공급 평형명 또는 fallback `전용 59~60㎡형` */
export function formatAreaGroupPrimaryLabel(group: AreaGroup): string {
  if (group.pyeongName) return group.pyeongName;
  const range = formatExclusiveRangeIntegers(
    group.minExclusiveArea,
    group.maxExclusiveArea,
  );
  return `전용 ${range}㎡형`;
}

/**
 * 2순위 라벨: `공급 81㎡ · 전용 59~60㎡`
 * 공급면적 없으면 null (UI에서 생략).
 */
export function formatAreaGroupSecondaryLabel(group: AreaGroup): string | null {
  const exclusive = formatExclusiveRangeIntegers(
    group.minExclusiveArea,
    group.maxExclusiveArea,
  );
  if (
    group.supplyAreaMin != null &&
    group.supplyAreaMax != null &&
    Number.isFinite(group.supplyAreaMin) &&
    Number.isFinite(group.supplyAreaMax)
  ) {
    const supply = formatSupplyRange(group.supplyAreaMin, group.supplyAreaMax);
    return `공급 ${supply}㎡ · 전용 ${exclusive}㎡`;
  }
  return null;
}

/** @deprecated use formatAreaGroupPrimaryLabel — sheet/trigger 단일 문자열 */
export function formatAreaGroupLabel(group: AreaGroup): string {
  const secondary = formatAreaGroupSecondaryLabel(group);
  if (secondary) return `${formatAreaGroupPrimaryLabel(group)} · ${secondary}`;
  return formatAreaGroupPrimaryLabel(group);
}

export function findAreaGroup(
  key: string,
  groups: AreaGroup[],
): AreaGroup | null {
  if (key === "all") return null;

  const direct = groups.find((g) => g.key === key);
  if (direct) return direct;

  for (const group of groups) {
    if (group.members.some((m) => m.key === key)) return group;
  }

  const asNum = Number(key);
  if (Number.isFinite(asNum) && asNum > 0) {
    const exact = normalizeAreaKey(asNum);
    return (
      groups.find((g) =>
        g.members.some(
          (m) =>
            m.key === exact || normalizeAreaKey(m.exclusiveArea) === exact,
        ),
      ) ?? null
    );
  }

  return null;
}

export function resolveToAreaGroupKey(
  key: string,
  areas: AptAreaOption[],
): string {
  if (key === "all") return "all";
  const group = findAreaGroup(key, buildAreaGroups(areas));
  return group?.key ?? "all";
}

export function isValidAreaSelectionKey(
  key: string,
  areas: AptAreaOption[],
): boolean {
  if (key === "all") return true;
  return findAreaGroup(key, buildAreaGroups(areas)) != null;
}

/** 그룹 members의 exact 전용면적에 속하는지 (신고가 판정과 무관 — 필터 전용) */
export function itemMatchesAreaGroup(
  exclusiveArea: number,
  groupKey: string,
  groups?: AreaGroup[],
): boolean {
  if (groupKey === "all") return true;

  if (groups && groups.length > 0) {
    const group = findAreaGroup(groupKey, groups);
    if (!group) return false;
    const exact = normalizeAreaKey(exclusiveArea);
    return group.members.some(
      (m) => m.key === exact || normalizeAreaKey(m.exclusiveArea) === exact,
    );
  }

  // groups 미전달 시: 싱글톤/레거시 exact 매칭만 (클러스터 재구성 금지)
  if (isAreaGroupKey(groupKey)) {
    const body = groupKey.slice(2);
    const [minRaw, maxRaw] = body.includes("-")
      ? (body.split("-") as [string, string])
      : [body, body];
    const min = Number(minRaw);
    const max = Number(maxRaw);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return false;
    const v = Number(normalizeAreaKey(exclusiveArea));
    return v >= min && v <= max;
  }

  return normalizeAreaKey(exclusiveArea) === normalizeAreaKey(Number(groupKey));
}

function pickGroupByTradeThenRecency(
  groups: AreaGroup[],
  statsByExactKey: Map<
    string,
    { tradeCount: number; latestTradeDate: string }
  >,
): AreaGroup | null {
  if (groups.length === 0) return null;

  const scored = groups.map((group) => {
    let tradeCount = 0;
    let latestTradeDate = "";
    for (const member of group.members) {
      const stat = statsByExactKey.get(member.key);
      if (!stat) continue;
      tradeCount += stat.tradeCount;
      if (stat.latestTradeDate > latestTradeDate) {
        latestTradeDate = stat.latestTradeDate;
      }
    }
    return { group, tradeCount, latestTradeDate };
  });

  scored.sort((a, b) => {
    if (b.tradeCount !== a.tradeCount) return b.tradeCount - a.tradeCount;
    if (a.latestTradeDate !== b.latestTradeDate) {
      return a.latestTradeDate < b.latestTradeDate ? 1 : -1;
    }
    return a.group.minExclusiveArea - b.group.minExclusiveArea;
  });

  return scored[0]?.group ?? null;
}

/**
 * 기본 선택 (그룹 단위):
 * 1) 84㎡대 포함 대표 그룹
 * 2) 매매 건수 최다 그룹
 * 3) all
 */
export function resolveDefaultAreaGroupKey(
  areas: AptAreaOption[],
  items: TradeLike[],
): string {
  if (!areas.length) return "all";

  const groups = buildAreaGroups(areas);
  if (groups.length === 0) return "all";

  const stats = buildAreaTradeStats(areas, items);
  const statsByKey = new Map(
    stats.map((s) => [
      s.key,
      { tradeCount: s.tradeCount, latestTradeDate: s.latestTradeDate },
    ]),
  );

  const band84Groups = groups.filter((g) =>
    g.members.some((m) => isArea84Band(m.exclusiveArea)),
  );
  if (band84Groups.length > 0) {
    return pickGroupByTradeThenRecency(band84Groups, statsByKey)?.key ?? "all";
  }

  const withTrades = groups.filter((g) =>
    g.members.some((m) => (statsByKey.get(m.key)?.tradeCount ?? 0) > 0),
  );
  if (withTrades.length === 0) return "all";

  return pickGroupByTradeThenRecency(withTrades, statsByKey)?.key ?? "all";
}
