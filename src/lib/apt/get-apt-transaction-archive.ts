/**
 * Phase 7.6c — bounded transaction-history archive (year + area + type).
 * Read-only. No public MOLIT calls. No writes.
 * When the warehouse is unavailable, fall back to the same payload as 단지상세.
 */
import { groupAreaOptions, parseAreaRangeKey, resolveAreaKeyAlias } from "@/lib/apt/area-groups";
import { getRegion } from "@/lib/constants/regions";
import { getDb, hasDb } from "@/lib/db/client";
import {
  queryAptArchiveAreaBuckets,
  queryAptArchiveKpi,
  queryAptArchivePage,
  queryAptArchiveYears,
  type AptArchiveAreaFilter,
  type AptArchiveListType,
  type AptArchiveYearBound,
} from "@/lib/db/repository";
import type {
  AptAreaOption,
  AptDetailResponse,
  AptHistoryItem,
} from "@/lib/molit/apt-client";
import { toPyeong } from "@/lib/utils/format";
import {
  matchesTransactionTab,
  type TransactionTabType,
} from "@/lib/apt/transaction-type";
import {
  parseTransactionYear,
  yearMonthBound,
  type TransactionYear,
} from "@/lib/apt/transaction-year";
import { normalizeAreaKey } from "@/lib/apt/default-area";
import type {
  AptArchiveHigh,
  AptTransactionArchiveKpi,
  AptTransactionArchiveResponse,
} from "@/lib/apt/transaction-archive-types";

export type {
  AptTransactionArchiveKpi,
  AptTransactionArchiveResponse,
} from "@/lib/apt/transaction-archive-types";

const EMPTY_KPI: AptTransactionArchiveKpi = {
  saleHigh: null,
  jeonseHigh: null,
  monthlyDepositHigh: null,
  monthlyRentHigh: null,
  tradeCount: 0,
  jeonseCount: 0,
  monthlyCount: 0,
};

function resolveLawdCodes(regionSlug: string, gu?: string): string[] {
  const region = getRegion(regionSlug);
  if (!region) return [];
  const needle = gu?.trim();
  if (!needle) return [...region.lawdCodes];
  const hit = region.districts.find(
    (d) =>
      needle === d.name || needle.includes(d.name) || d.name.includes(needle),
  );
  return hit ? [hit.code] : [...region.lawdCodes];
}

function listTypeOf(type: TransactionTabType): AptArchiveListType {
  return type;
}

function areaFilterFor(
  areaKey: string,
  areas: AptAreaOption[],
): AptArchiveAreaFilter {
  if (!areaKey || areaKey === "all") return { kind: "all" };
  // 묶인 평형("84.92-84.99")은 key만으로 범위를 안다 — 면적 목록 없이 오는 다음 페이지 요청도 같게 거른다
  const range = parseAreaRangeKey(areaKey);
  if (range) return { kind: "range", min: range.min - 0.005, max: range.max + 0.005 };
  const selected = areas.find((a) => a.key === areaKey);
  if (
    selected?.selectorKind === "market_group" &&
    selected.exclusiveAreaMin != null &&
    selected.exclusiveAreaMax != null
  ) {
    return {
      kind: "range",
      min: selected.exclusiveAreaMin - 0.005,
      max: selected.exclusiveAreaMax + 0.005,
    };
  }
  const key = selected
    ? normalizeAreaKey(selected.exclusiveArea)
    : areaKey;
  return { kind: "exclusive", areaKey: key };
}

function exclusiveAreasFromBuckets(
  buckets: Array<{ exclusiveArea: number; count: number }>,
): AptAreaOption[] {
  return buckets
    .map((b) => {
      const sqm = Number(b.exclusiveArea);
      const safe = Number.isFinite(sqm) ? sqm : 0;
      return {
        key: normalizeAreaKey(safe),
        exclusiveArea: safe,
        count: b.count,
        label: `${Number.isFinite(sqm) ? sqm.toFixed(2) : "—"}㎡`,
        selectorKind: "exclusive" as const,
      };
    })
    .sort((a, b) => a.exclusiveArea - b.exclusiveArea);
}

function highOf(
  items: AptHistoryItem[],
  amountOf: (item: AptHistoryItem) => number,
): AptArchiveHigh {
  let best: AptArchiveHigh = null;
  for (const item of items) {
    const amount = amountOf(item);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (
      !best ||
      amount > best.amount ||
      (amount === best.amount && item.dealDate > best.date)
    ) {
      best = { amount, date: item.dealDate };
    }
  }
  return best;
}

function itemMatchesArea(
  tx: { exclusiveArea: number },
  area: AptArchiveAreaFilter,
): boolean {
  if (area.kind === "all") return true;
  if (area.kind === "range") {
    return tx.exclusiveArea >= area.min && tx.exclusiveArea <= area.max;
  }
  return normalizeAreaKey(tx.exclusiveArea) === area.areaKey;
}

function itemMatchesYear(
  tx: { dealDate: string },
  year: TransactionYear,
): boolean {
  if (year === "all") return true;
  return tx.dealDate.slice(0, 4) === year;
}

export type ArchiveQueryParams = {
  aptName: string;
  regionSlug: string;
  gu?: string;
  areaKey?: string;
  type: TransactionTabType;
  year: TransactionYear;
  offset?: number;
  limit?: number;
};

/** Pure rebuild of the archive payload from 단지상세 items (no warehouse). */
export function buildArchiveFromDetail(
  detail: AptDetailResponse,
  params: ArchiveQueryParams,
  timingMs: Record<string, number> = {},
): AptTransactionArchiveResponse {
  const year = parseTransactionYear(params.year);
  const offset = Math.max(params.offset ?? 0, 0);
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
  const includeMeta = offset === 0;
  const areas = detail.areas ?? [];
  const requestedArea = params.areaKey?.trim() || "";
  const aliased = requestedArea ? resolveAreaKeyAlias(requestedArea, areas) : null;
  const areaKey =
    requestedArea && (areas.length === 0 || aliased)
      ? (aliased ?? requestedArea)
      : (areas[0]?.key ?? (requestedArea || "all"));
  const area = areaFilterFor(areaKey, areas);

  const scoped = detail.items.filter(
    (tx) => itemMatchesArea(tx, area) && itemMatchesYear(tx, year),
  );
  const trades = scoped.filter((tx) => tx.dealType === "trade");
  const jeonse = scoped.filter(
    (tx) => tx.dealType === "rent" && Number(tx.monthlyRent ?? 0) === 0,
  );
  const monthly = scoped.filter(
    (tx) => tx.dealType === "rent" && Number(tx.monthlyRent ?? 0) > 0,
  );

  const kpi: AptTransactionArchiveKpi = includeMeta
    ? {
        saleHigh: highOf(trades, (tx) => tx.dealAmount),
        jeonseHigh: highOf(jeonse, (tx) => tx.dealAmount),
        monthlyDepositHigh: highOf(monthly, (tx) => tx.dealAmount),
        monthlyRentHigh: highOf(monthly, (tx) => Number(tx.monthlyRent ?? 0)),
        tradeCount: trades.length,
        jeonseCount: jeonse.length,
        monthlyCount: monthly.length,
      }
    : EMPTY_KPI;

  const typed = scoped
    .filter((tx) => matchesTransactionTab(tx, params.type))
    .sort((a, b) => {
      if (a.dealDate < b.dealDate) return 1;
      if (a.dealDate > b.dealDate) return -1;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
  const items = typed.slice(offset, offset + limit);
  const total = includeMeta
    ? params.type === "trade"
      ? kpi.tradeCount
      : params.type === "jeonse"
        ? kpi.jeonseCount
        : kpi.monthlyCount
    : 0;

  const years = includeMeta
    ? [
        ...new Set(
          detail.items
            .map((tx) => Number(tx.dealDate.slice(0, 4)))
            .filter((y) => Number.isFinite(y) && y >= 1990 && y <= 2100),
        ),
      ].sort((a, b) => b - a)
    : [];

  return {
    aptName: detail.aptName || params.aptName,
    regionSlug: params.regionSlug,
    years,
    year,
    areas: includeMeta ? areas : [],
    areaKey,
    type: params.type,
    items,
    offset,
    limit,
    total,
    hasMore: includeMeta
      ? offset + items.length < total
      : items.length === limit,
    kpi,
    timingMs,
    metaIncluded: includeMeta,
  };
}

async function archiveFromAptDetail(
  params: ArchiveQueryParams,
): Promise<AptTransactionArchiveResponse | null> {
  const tAll = performance.now();
  const { getAptDetail } = await import("@/lib/molit/apt");
  const detail = await getAptDetail({
    aptName: params.aptName,
    regionSlug: params.regionSlug,
    gu: params.gu,
    months: 120,
    boundMonths: false,
  });
  if (!detail) return null;
  return buildArchiveFromDetail(detail, params, {
    fallbackMs: Math.round(performance.now() - tAll),
  });
}

export async function getAptTransactionArchive(
  params: ArchiveQueryParams,
): Promise<AptTransactionArchiveResponse | null> {
  const region = getRegion(params.regionSlug);
  if (!region) return null;
  const aptName = params.aptName.trim();
  if (!aptName) return null;

  if (!hasDb()) {
    return archiveFromAptDetail({ ...params, aptName });
  }

  try {
    return await loadWarehouseArchive({ ...params, aptName });
  } catch (error) {
    console.error(
      "[apt-archive] warehouse failed, falling back to detail",
      error,
    );
    return archiveFromAptDetail({ ...params, aptName });
  }
}

async function loadWarehouseArchive(
  params: ArchiveQueryParams & { aptName: string },
): Promise<AptTransactionArchiveResponse | null> {
  const year = parseTransactionYear(params.year);
  const yearBound: AptArchiveYearBound = yearMonthBound(year);
  const lawdCodes = resolveLawdCodes(params.regionSlug, params.gu);
  const offset = Math.max(params.offset ?? 0, 0);
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
  const listType = listTypeOf(params.type);
  const includeMeta = offset === 0;
  const timing: Record<string, number> = {};
  const mark = (key: string, started: number) => {
    timing[key] = Math.round(performance.now() - started);
  };
  const tAll = performance.now();
  const aptName = params.aptName;

  const {
    applyPilotSingoga,
    attachCanonicalPyeongLabelSource,
    buildMarketGroupAreas,
    loadPilotMasterForApt,
  } = await import("@/lib/unit-type/apply-pilot");

  const tMeta = performance.now();
  const [pilotBundle, years, yearBuckets] = includeMeta
    ? await Promise.all([
        loadPilotMasterForApt(aptName),
        queryAptArchiveYears({ lawdCodes, aptName }),
        queryAptArchiveAreaBuckets({ lawdCodes, aptName, yearBound }),
      ])
    : await Promise.all([
        loadPilotMasterForApt(aptName),
        Promise.resolve([] as number[]),
        Promise.resolve(
          [] as Array<{ exclusiveArea: number; count: number }>,
        ),
      ]);
  mark(includeMeta ? "metaMs" : "pilotMs", tMeta);

  const useMarketGroups =
    pilotBundle != null &&
    (await import("@/lib/unit-type/pilot")).isMarketGroupClass(
      pilotBundle.classification.classification,
    );

  let areas: AptAreaOption[] = [];
  if (includeMeta) {
    let lifetimeBuckets = yearBuckets;
    if (yearBuckets.length === 0 && yearBound) {
      const tLife = performance.now();
      lifetimeBuckets = await queryAptArchiveAreaBuckets({
        lawdCodes,
        aptName,
        yearBound: null,
      });
      mark("lifetimeBucketsMs", tLife);
    }

    if (useMarketGroups && pilotBundle) {
      const stubDeals = yearBuckets.map((b) => ({
        exclusiveArea: b.exclusiveArea,
      }));
      areas = buildMarketGroupAreas(pilotBundle, stubDeals).map((g) => {
        const count = yearBuckets
          .filter(
            (b) =>
              b.exclusiveArea >=
                (g.exclusiveAreaMin ?? b.exclusiveArea) - 0.005 &&
              b.exclusiveArea <=
                (g.exclusiveAreaMax ?? b.exclusiveArea) + 0.005,
          )
          .reduce((s, b) => s + b.count, 0);
        return { ...g, count };
      });
    } else {
      areas = groupAreaOptions(
        exclusiveAreasFromBuckets(yearBuckets).map((area) =>
          attachCanonicalPyeongLabelSource(area, pilotBundle),
        ),
      );
      if (areas.length === 0) {
        areas = groupAreaOptions(
          exclusiveAreasFromBuckets(lifetimeBuckets).map((area) =>
            attachCanonicalPyeongLabelSource(area, pilotBundle),
          ),
        );
      }
    }
  } else if (useMarketGroups && pilotBundle) {
    areas = buildMarketGroupAreas(pilotBundle, []);
  }

  const requestedArea = params.areaKey?.trim() || "";
  const aliasedArea = requestedArea ? resolveAreaKeyAlias(requestedArea, areas) : null;
  const areaKey =
    requestedArea && (areas.length === 0 || aliasedArea)
      ? (aliasedArea ?? requestedArea)
      : (areas[0]?.key ?? (requestedArea || "all"));
  const area = areaFilterFor(areaKey, areas);

  let kpi = EMPTY_KPI;
  if (includeMeta) {
    const tKpi = performance.now();
    kpi = await queryAptArchiveKpi({
      lawdCodes,
      aptName,
      yearBound,
      area,
    });
    mark("kpiMs", tKpi);
  }

  const tPage = performance.now();
  const rows = await queryAptArchivePage({
    lawdCodes,
    aptName,
    yearBound,
    area,
    listType,
    offset,
    limit,
  });
  mark("pageMs", tPage);

  let baselinePriorMax: Map<string, number> | undefined;
  if (useMarketGroups && pilotBundle) {
    const { isMarketGroupBaselineSingogaEnabled } = await import(
      "@/lib/unit-type/baseline-gate"
    );
    if (isMarketGroupBaselineSingogaEnabled()) {
      const { loadBaselinePriorMaxByComplex } = await import(
        "@/lib/unit-type/baselines"
      );
      const db = getDb();
      if (db) {
        baselinePriorMax = await loadBaselinePriorMaxByComplex(
          db,
          pilotBundle.classification.complexKey,
        );
      }
    }
  }

  const singogaFlags = applyPilotSingoga({
    bundle: pilotBundle,
    deals: rows.map((tx) => ({
      id: tx.id,
      dealType: tx.dealType,
      dealDate: tx.dealDate,
      dealAmount: tx.dealAmount,
      exclusiveArea: tx.exclusiveArea,
    })),
    baselinePriorMax,
  });

  const items: AptHistoryItem[] = rows.map((tx) => ({
    ...tx,
    pyeong: toPyeong(tx.exclusiveArea),
    isSingoga: tx.dealType === "trade" && (singogaFlags.get(tx.id) ?? false),
  }));

  const total = includeMeta
    ? params.type === "trade"
      ? kpi.tradeCount
      : params.type === "jeonse"
        ? kpi.jeonseCount
        : kpi.monthlyCount
    : 0;

  mark("totalMs", tAll);

  return {
    aptName: rows[0]?.aptName || aptName,
    regionSlug: params.regionSlug,
    years,
    year,
    areas,
    areaKey,
    type: params.type,
    items,
    offset,
    limit,
    total,
    hasMore: includeMeta
      ? offset + items.length < total
      : items.length === limit,
    kpi,
    timingMs: timing,
    metaIncluded: includeMeta,
  };
}
