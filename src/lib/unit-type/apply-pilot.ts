import type { AptAreaOption } from "@/lib/molit/apt-client";
import type { UnitTypeMasterBundle } from "@/lib/unit-type/types";
import { isMarketGroupClass } from "@/lib/unit-type/pilot";
import {
  formatMarketGroupLabel,
  formatMarketGroupSecondary,
} from "@/lib/unit-type/labels";
import {
  markSingogaExclusiveAllTimeMax,
  markSingogaMarketGroupPriorExceed,
} from "@/lib/unit-type/singoga";
import { loadUnitTypeMasterByAptName } from "@/lib/unit-type/repository";
import { isMarketGroupBaselineSingogaEnabled } from "@/lib/unit-type/baseline-gate";

export type UnitTypePilotMeta = {
  complexKey: string;
  classification: string;
  singogaMode: string;
  selectorMode: "market_group" | "exclusive";
};

export async function loadPilotMasterForApt(
  aptName: string,
): Promise<UnitTypeMasterBundle | null> {
  return loadUnitTypeMasterByAptName(aptName.replace(/\s+/g, ""));
}

export function pilotMetaFromBundle(
  bundle: UnitTypeMasterBundle | null,
): UnitTypePilotMeta | null {
  if (!bundle) return null;
  const market = isMarketGroupClass(bundle.classification.classification);
  return {
    complexKey: bundle.classification.complexKey,
    classification: bundle.classification.classification,
    singogaMode: bundle.classification.singogaMode,
    selectorMode: market ? "market_group" : "exclusive",
  };
}

export function buildMarketGroupAreas(
  bundle: UnitTypeMasterBundle,
  deals: Array<{ exclusiveArea: number }>,
): AptAreaOption[] {
  return bundle.groups
    .filter((g) => g.groupConfidenceHigh)
    .map((g) => {
      const count = deals.filter(
        (d) =>
          d.exclusiveArea >= g.exclusiveAreaMin - 0.005 &&
          d.exclusiveArea <= g.exclusiveAreaMax + 0.005,
      ).length;
      return {
        key: g.groupKey,
        label: formatMarketGroupLabel({
          marketLabel: g.marketLabel,
          displayMode: g.displayMode,
          supplyAreaMin: g.supplyAreaMin,
          supplyAreaMax: g.supplyAreaMax,
          exclusiveAreaMin: g.exclusiveAreaMin,
          exclusiveAreaMax: g.exclusiveAreaMax,
        }),
        exclusiveArea: g.exclusiveAreaMin,
        count,
        selectorKind: "market_group" as const,
        exclusiveAreaMin: g.exclusiveAreaMin,
        exclusiveAreaMax: g.exclusiveAreaMax,
        supplyAreaMin: g.supplyAreaMin,
        supplyAreaMax: g.supplyAreaMax,
        secondaryLabel: formatMarketGroupSecondary({
          displayMode: g.displayMode,
          supplyAreaMin: g.supplyAreaMin,
          supplyAreaMax: g.supplyAreaMax,
          exclusiveAreaMin: g.exclusiveAreaMin,
          exclusiveAreaMax: g.exclusiveAreaMax,
        }),
        marketLabel: g.marketLabel,
      };
    })
    .sort((a, b) => a.exclusiveArea - b.exclusiveArea);
}

/**
 * Overlay market/supply label fields from pyeong groups or unit types.
 * Does not invent exclusive-area 평. No-op when no master match.
 */
export function attachCanonicalPyeongLabelSource(
  area: AptAreaOption,
  bundle: UnitTypeMasterBundle | null,
): AptAreaOption {
  if (!bundle) return area;
  const hasMarket =
    area.marketLabel != null && Number.isFinite(area.marketLabel);
  const hasSupply =
    area.supplyAreaMin != null &&
    area.supplyAreaMax != null &&
    area.supplyAreaMin > 0 &&
    area.supplyAreaMax > 0;
  if (hasMarket || hasSupply) return area;

  const exMin = area.exclusiveAreaMin ?? area.exclusiveArea;
  const exMax = area.exclusiveAreaMax ?? area.exclusiveArea;
  const mid = (exMin + exMax) / 2;
  const group = bundle.groups.find(
    (g) =>
      mid >= g.exclusiveAreaMin - 0.05 && mid <= g.exclusiveAreaMax + 0.05,
  );
  if (group) {
    return {
      ...area,
      marketLabel: group.marketLabel ?? area.marketLabel,
      supplyAreaMin: group.supplyAreaMin ?? area.supplyAreaMin,
      supplyAreaMax: group.supplyAreaMax ?? area.supplyAreaMax,
    };
  }

  const supplies = bundle.unitTypes
    .filter(
      (u) =>
        u.supplyAreaSqm != null &&
        u.supplyAreaSqm > 0 &&
        mid >= u.exclusiveAreaMin - 0.05 &&
        mid <= u.exclusiveAreaMax + 0.05,
    )
    .map((u) => u.supplyAreaSqm as number);
  if (supplies.length === 0) return area;
  return {
    ...area,
    supplyAreaMin: Math.min(...supplies),
    supplyAreaMax: Math.max(...supplies),
  };
}

export function applyPilotSingoga(params: {
  bundle: UnitTypeMasterBundle | null;
  deals: Array<{
    id: string;
    dealType: string;
    dealDate: string;
    dealAmount: number;
    exclusiveArea: number;
  }>;
  /** Pre-warehouse prior-max by groupKey. Applied only when baseline gate is open. */
  baselinePriorMax?: ReadonlyMap<string, number>;
  /** Optional env override for tests. */
  env?: NodeJS.ProcessEnv;
}): Map<string, boolean> {
  const { bundle, deals, baselinePriorMax, env = process.env } = params;
  if (!bundle || !isMarketGroupClass(bundle.classification.classification)) {
    // C/D exclusive fallback — unchanged; baselines never apply.
    return markSingogaExclusiveAllTimeMax(deals);
  }
  const groups = bundle.groups
    .filter((g) => g.groupConfidenceHigh)
    .map((g) => ({
      groupKey: g.groupKey,
      exclusiveAreaMin: g.exclusiveAreaMin,
      exclusiveAreaMax: g.exclusiveAreaMax,
      groupConfidenceHigh: true,
    }));
  const useBaseline =
    isMarketGroupBaselineSingogaEnabled(env) &&
    baselinePriorMax != null &&
    baselinePriorMax.size > 0;
  return markSingogaMarketGroupPriorExceed(
    deals,
    groups,
    useBaseline ? baselinePriorMax : undefined,
  );
}
