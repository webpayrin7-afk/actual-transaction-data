import type {
  AptAreaOption,
  AptDetailResponse,
} from "@/lib/molit/apt-client";

export type CompareAreaRef = {
  key: string;
  label: string;
  exclusiveMin: number;
  exclusiveMax: number;
};

export type CompareComplexMetrics = {
  aptName: string;
  regionSlug: string;
  gu: string;
  dong: string;
  buildYear: number | null;
  householdCount: number | null;
  matchedArea: CompareAreaRef | null;
  matchNote: string | null;
  latestSaleMan: number | null;
  latestSaleDate: string | null;
  latestJeonseMan: number | null;
  latestJeonseDate: string | null;
  /** 만원 / ㎡ from latest sale ÷ matched exclusive center */
  salePerSqmMan: number | null;
  jeonseRatioPct: number | null;
  saleCount12m: number;
  periodHighSaleMan: number | null;
  vsPeriodHighPct: number | null;
};

function areaRange(a: AptAreaOption): { min: number; max: number } {
  const min = a.exclusiveAreaMin ?? a.exclusiveArea;
  const max = a.exclusiveAreaMax ?? a.exclusiveArea;
  return { min, max };
}

function areaCenter(a: AptAreaOption): number {
  const { min, max } = areaRange(a);
  return (min + max) / 2;
}

/**
 * Match comparator area to the current Phase5/exclusive selection by exclusive-㎡
 * overlap / nearest center. Refuse silent 84㎡↔114㎡ mismatches.
 */
export function matchComparableArea(
  areas: AptAreaOption[],
  target: CompareAreaRef | null,
): { area: AptAreaOption | null; note: string | null } {
  if (!target || areas.length === 0) {
    return { area: null, note: "비교 가능한 유사 면적 없음" };
  }
  const tCenter = (target.exclusiveMin + target.exclusiveMax) / 2;

  const cands = areas
    .filter((a) => a.key !== "all")
    .map((a) => {
      const { min, max } = areaRange(a);
      const overlap = Math.max(
        0,
        Math.min(max, target.exclusiveMax) - Math.max(min, target.exclusiveMin),
      );
      return {
        area: a,
        overlap,
        centerGap: Math.abs(areaCenter(a) - tCenter),
      };
    })
    .sort((a, b) => {
      if (b.overlap !== a.overlap) return b.overlap - a.overlap;
      return a.centerGap - b.centerGap;
    });

  const best = cands[0];
  if (!best) return { area: null, note: "비교 가능한 유사 면적 없음" };

  const overlaps = best.overlap > 0.05;
  const close = best.centerGap <= 18;
  if (!overlaps && !close) {
    return { area: null, note: "비교 가능한 유사 면적 없음" };
  }

  const note =
    !overlaps && close
      ? `유사 면적 (전용 ${(best.area.exclusiveAreaMin ?? best.area.exclusiveArea).toFixed(0)}㎡대)`
      : null;
  return { area: best.area, note };
}

function inArea(exclusiveArea: number, area: AptAreaOption | null): boolean {
  if (!area) return true;
  if (
    area.selectorKind === "market_group" &&
    area.exclusiveAreaMin != null &&
    area.exclusiveAreaMax != null
  ) {
    return (
      exclusiveArea >= area.exclusiveAreaMin - 0.005 &&
      exclusiveArea <= area.exclusiveAreaMax + 0.005
    );
  }
  return Math.abs(exclusiveArea - area.exclusiveArea) < 0.05;
}

function monthsAgoYm(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function buildCompareMetrics(
  detail: AptDetailResponse,
  targetArea: CompareAreaRef | null,
): CompareComplexMetrics {
  const { area: matched, note } = matchComparableArea(detail.areas, targetArea);
  const items = detail.items.filter((it) =>
    inArea(Number(it.exclusiveArea), matched),
  );

  const saleRows = items
    .filter((i) => i.dealType === "trade")
    .sort((a, b) => (a.dealDate < b.dealDate ? 1 : -1));

  const jeonseRows = items
    .filter((i) => i.dealType === "rent" && Number(i.monthlyRent ?? 0) === 0)
    .sort((a, b) => (a.dealDate < b.dealDate ? 1 : -1));

  const latestSale = saleRows[0] ?? null;
  const latestJeonse = jeonseRows[0] ?? null;
  const fromYm = monthsAgoYm(12);
  const saleCount12m = saleRows.filter((r) => {
    const ym = r.dealDate.replace(/-/g, "").slice(0, 6);
    return ym >= fromYm;
  }).length;

  const periodHigh = saleRows.reduce(
    (max, r) => Math.max(max, Number(r.dealAmount) || 0),
    0,
  );
  const latestSaleMan = latestSale ? Number(latestSale.dealAmount) : null;
  const latestJeonseMan = latestJeonse ? Number(latestJeonse.dealAmount) : null;
  const jeonseRatioPct =
    latestSaleMan && latestJeonseMan && latestSaleMan > 0
      ? Math.round((latestJeonseMan / latestSaleMan) * 1000) / 10
      : null;
  const vsPeriodHighPct =
    latestSaleMan && periodHigh > 0
      ? Math.round((latestSaleMan / periodHigh - 1) * 1000) / 10
      : null;

  const matchedRef: CompareAreaRef | null = matched
    ? {
        key: matched.key,
        label: matched.label,
        exclusiveMin: matched.exclusiveAreaMin ?? matched.exclusiveArea,
        exclusiveMax: matched.exclusiveAreaMax ?? matched.exclusiveArea,
      }
    : null;

  const areaCenterSqm = matchedRef
    ? (matchedRef.exclusiveMin + matchedRef.exclusiveMax) / 2
    : null;
  const salePerSqmMan =
    latestSaleMan != null &&
    areaCenterSqm != null &&
    areaCenterSqm > 0
      ? Math.round(latestSaleMan / areaCenterSqm)
      : null;

  return {
    aptName: detail.aptName,
    regionSlug: detail.regionSlug,
    gu: detail.gu,
    dong: detail.dong,
    buildYear: detail.buildYear,
    householdCount: null,
    matchedArea: matchedRef,
    matchNote: matched ? note : "비교 가능한 유사 면적 없음",
    latestSaleMan,
    latestSaleDate: latestSale?.dealDate ?? null,
    latestJeonseMan,
    latestJeonseDate: latestJeonse?.dealDate ?? null,
    salePerSqmMan,
    jeonseRatioPct,
    saleCount12m,
    periodHighSaleMan: periodHigh > 0 ? periodHigh : null,
    vsPeriodHighPct,
  };
}

/** Attach household when known (from complex detail / peer selection). */
export function withHouseholdCount(
  metrics: CompareComplexMetrics,
  householdCount: number | null | undefined,
): CompareComplexMetrics {
  return {
    ...metrics,
    householdCount:
      householdCount != null && householdCount > 0 ? householdCount : null,
  };
}

export function compareAreaRefFromOption(
  area: AptAreaOption | null,
  fallbackLabel: string,
): CompareAreaRef | null {
  if (!area || area.key === "all") return null;
  return {
    key: area.key,
    label: fallbackLabel || area.label,
    exclusiveMin: area.exclusiveAreaMin ?? area.exclusiveArea,
    exclusiveMax: area.exclusiveAreaMax ?? area.exclusiveArea,
  };
}

/** Deterministic, non-subjective insight strings (max 3). */
export function buildCompareInsights(
  base: CompareComplexMetrics,
  peers: CompareComplexMetrics[],
): string[] {
  const out: string[] = [];
  for (const peer of peers) {
    if (
      base.saleCount12m > 0 &&
      peer.saleCount12m > 0 &&
      base.saleCount12m !== peer.saleCount12m
    ) {
      const more = base.saleCount12m > peer.saleCount12m ? base : peer;
      const less = more === base ? peer : base;
      out.push(
        `${more.aptName}은(는) ${less.aptName}보다 최근 12개월 매매 거래가 ${more.saleCount12m - less.saleCount12m}건 많습니다.`,
      );
    }
    if (
      base.jeonseRatioPct != null &&
      peer.jeonseRatioPct != null &&
      Math.abs(base.jeonseRatioPct - peer.jeonseRatioPct) >= 1
    ) {
      const higher =
        base.jeonseRatioPct > peer.jeonseRatioPct ? base : peer;
      const lower = higher === base ? peer : base;
      const diff =
        Math.round((higher.jeonseRatioPct! - lower.jeonseRatioPct!) * 10) / 10;
      out.push(
        `${higher.aptName}의 전세가율이 ${lower.aptName}보다 ${diff}%p 높습니다.`,
      );
    }
    if (
      base.latestSaleMan != null &&
      peer.latestSaleMan != null &&
      base.latestSaleMan !== peer.latestSaleMan
    ) {
      const higher =
        base.latestSaleMan > peer.latestSaleMan ? base : peer;
      const lower = higher === base ? peer : base;
      out.push(
        `최근 매매가는 ${higher.aptName}이(가) ${lower.aptName}보다 높습니다.`,
      );
    }
  }
  return out.slice(0, 3);
}
