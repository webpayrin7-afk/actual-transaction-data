/**
 * Phase 7.6c — bounded transaction-history archive (year + area + type).
 * Read-only. No public MOLIT calls. No writes.
 */
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
import type { AptAreaOption, AptHistoryItem } from "@/lib/molit/apt-client";
import { toPyeong } from "@/lib/utils/format";
import type { TransactionTabType } from "@/lib/apt/transaction-type";
import {
  parseTransactionYear,
  yearMonthBound,
  type TransactionYear,
} from "@/lib/apt/transaction-year";
import { normalizeAreaKey } from "@/lib/apt/default-area";
import type {
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
    .map((b) => ({
      key: normalizeAreaKey(b.exclusiveArea),
      exclusiveArea: b.exclusiveArea,
      count: b.count,
      label: `${b.exclusiveArea.toFixed(2)}㎡`,
      selectorKind: "exclusive" as const,
    }))
    .sort((a, b) => a.exclusiveArea - b.exclusiveArea);
}

export async function getAptTransactionArchive(params: {
  aptName: string;
  regionSlug: string;
  gu?: string;
  areaKey?: string;
  type: TransactionTabType;
  year: TransactionYear;
  offset?: number;
  limit?: number;
}): Promise<AptTransactionArchiveResponse | null> {
  const region = getRegion(params.regionSlug);
  if (!region) return null;
  const aptName = params.aptName.trim();
  if (!aptName) return null;
  if (!hasDb()) return null;

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

  const {
    applyPilotSingoga,
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
      areas = exclusiveAreasFromBuckets(yearBuckets);
      if (areas.length === 0) {
        areas = exclusiveAreasFromBuckets(lifetimeBuckets);
      }
    }
  } else if (useMarketGroups && pilotBundle) {
    areas = buildMarketGroupAreas(pilotBundle, []);
  }

  const requestedArea = params.areaKey?.trim() || "";
  const areaKey =
    requestedArea &&
    (areas.length === 0 || areas.some((a) => a.key === requestedArea))
      ? requestedArea
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
