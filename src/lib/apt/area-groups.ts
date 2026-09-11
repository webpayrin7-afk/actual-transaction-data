import type { AptAreaOption } from "@/lib/molit/apt";
import {
  buildAreaTradeStats,
  isArea84Band,
  normalizeAreaKey,
} from "@/lib/apt/default-area";

/**
 * 유사 전용면적 그룹.
 *
 * Grouping: Math.floor(전용㎡)
 *  - 59.82 / 59.91 / 59.96 → g:59 ("전용 59㎡형")
 *  - 84.78 / 84.82 / 84.97 → g:84 ("전용 84㎡형")
 *
 * 공급면적/평형 필드는 repo·DB에 없음 → 평형 라벨 추정 금지.
 * exact areaKey(0.01㎡)는 members로 유지. 신고가(isSingoga)는 exact areaKey 기준(서버) 불변.
 */
export type AreaGroup = {
  /** 선택 값. 예: "g:84" */
  key: string;
  exclusiveFloor: number;
  members: AptAreaOption[];
  count: number;
  minExclusiveArea: number;
  maxExclusiveArea: number;
};

type TradeLike = {
  dealType: string;
  exclusiveArea: number;
  dealDate: string;
};

export function exclusiveAreaFloor(sqm: number): number {
  if (!Number.isFinite(sqm) || sqm <= 0) return 0;
  return Math.floor(sqm);
}

export function areaGroupKeyFromSqm(sqm: number): string {
  return `g:${exclusiveAreaFloor(sqm)}`;
}

export function isAreaGroupKey(key: string): boolean {
  return /^g:\d+$/.test(key);
}

export function buildAreaGroups(areas: AptAreaOption[]): AreaGroup[] {
  const map = new Map<number, AptAreaOption[]>();

  for (const area of areas) {
    const floor = exclusiveAreaFloor(area.exclusiveArea);
    const list = map.get(floor);
    if (list) list.push(area);
    else map.set(floor, [area]);
  }

  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([floor, members]) => {
      const sorted = [...members].sort(
        (a, b) => a.exclusiveArea - b.exclusiveArea,
      );
      return {
        key: `g:${floor}`,
        exclusiveFloor: floor,
        members: sorted,
        count: sorted.reduce((sum, m) => sum + m.count, 0),
        minExclusiveArea: sorted[0]!.exclusiveArea,
        maxExclusiveArea: sorted[sorted.length - 1]!.exclusiveArea,
      };
    });
}

/** 공급면적 없음 → "전용 N㎡형"만 (전용÷3.3 평형 표기 금지) */
export function formatAreaGroupLabel(group: AreaGroup): string {
  return `전용 ${group.exclusiveFloor}㎡형`;
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

  if (isAreaGroupKey(key)) {
    const floor = Number(key.slice(2));
    return groups.find((g) => g.exclusiveFloor === floor) ?? null;
  }

  const asNum = Number(key);
  if (Number.isFinite(asNum) && asNum > 0) {
    const floor = exclusiveAreaFloor(asNum);
    return groups.find((g) => g.exclusiveFloor === floor) ?? null;
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

export function itemMatchesAreaGroup(
  exclusiveArea: number,
  groupKey: string,
): boolean {
  if (groupKey === "all") return true;
  if (isAreaGroupKey(groupKey)) {
    return areaGroupKeyFromSqm(exclusiveArea) === groupKey;
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
    return a.group.exclusiveFloor - b.group.exclusiveFloor;
  });

  return scored[0]?.group ?? null;
}

/**
 * 기본 선택 (그룹 단위):
 * 1) 84㎡대 포함 그룹
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
