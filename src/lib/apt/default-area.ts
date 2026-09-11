import type { AptAreaOption } from "@/lib/molit/apt";

/** 기존 areaKey normalization과 동일 */
export function normalizeAreaKey(sqm: number): string {
  return String(Math.round(sqm * 100) / 100);
}

/** 84㎡대: 84 이상 ~ 85 미만 (실제 areaKey는 합치지 않음) */
export function isArea84Band(sqm: number): boolean {
  return sqm >= 84 && sqm < 85;
}

export type AreaTradeStat = {
  key: string;
  exclusiveArea: number;
  tradeCount: number;
  latestTradeDate: string; // YYYY-MM-DD or ""
};

type TradeLike = {
  dealType: string;
  exclusiveArea: number;
  dealDate: string;
};

/**
 * 이미 로드된 단지 상세 items(매매)로 면적별 거래 통계를 만든다.
 * 추가 DB full scan 없음.
 */
export function buildAreaTradeStats(
  areas: AptAreaOption[],
  items: TradeLike[],
): AreaTradeStat[] {
  const map = new Map<string, AreaTradeStat>();

  for (const area of areas) {
    map.set(area.key, {
      key: area.key,
      exclusiveArea: area.exclusiveArea,
      tradeCount: 0,
      latestTradeDate: "",
    });
  }

  for (const item of items) {
    if (item.dealType !== "trade") continue;
    const key = normalizeAreaKey(item.exclusiveArea);
    let stat = map.get(key);
    if (!stat) {
      stat = {
        key,
        exclusiveArea: item.exclusiveArea,
        tradeCount: 0,
        latestTradeDate: "",
      };
      map.set(key, stat);
    }
    stat.tradeCount += 1;
    if (item.dealDate && item.dealDate > stat.latestTradeDate) {
      stat.latestTradeDate = item.dealDate;
    }
  }

  return [...map.values()];
}

function pickByTradeThenRecency(candidates: AreaTradeStat[]): AreaTradeStat | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    if (b.tradeCount !== a.tradeCount) return b.tradeCount - a.tradeCount;
    if (a.latestTradeDate !== b.latestTradeDate) {
      return a.latestTradeDate < b.latestTradeDate ? 1 : -1;
    }
    return a.exclusiveArea - b.exclusiveArea;
  })[0]!;
}

/**
 * 단지 상세 최초 진입 기본 면적 (exact areaKey — 레거시).
 * 그룹 단위 기본값은 resolveDefaultAreaGroupKey 사용.
 * 1) 84㎡대 존재 → 그중 매매 건수 최다 (동률 시 최근 매매)
 * 2) 없으면 전체 면적 중 매매 건수 최다 (동률 시 최근 매매)
 * 3) 매매 데이터로 판단 불가 → "all"
 *
 * areaKey를 합치지 않음. 반환값은 기존 areaKey 문자열.
 */
export function resolveDefaultAreaKey(
  areas: AptAreaOption[],
  items: TradeLike[],
): string {
  if (!areas.length) return "all";

  const stats = buildAreaTradeStats(areas, items);
  const byKey = new Map(stats.map((s) => [s.key, s]));

  const band84 = areas
    .filter((a) => isArea84Band(a.exclusiveArea))
    .map((a) => byKey.get(a.key)!)
    .filter(Boolean);

  if (band84.length > 0) {
    const picked = pickByTradeThenRecency(band84);
    return picked?.key ?? "all";
  }

  const withTrades = stats.filter((s) => s.tradeCount > 0);
  if (withTrades.length === 0) return "all";

  const picked = pickByTradeThenRecency(withTrades);
  return picked?.key ?? "all";
}

/** URL/query로 넘어온 area가 유효한지 */
export function isValidAreaKey(
  areaKey: string,
  areas: AptAreaOption[],
): boolean {
  if (areaKey === "all") return true;
  return areas.some((a) => a.key === areaKey);
}
