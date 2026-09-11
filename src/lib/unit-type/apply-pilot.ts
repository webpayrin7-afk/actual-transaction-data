import type { AptAreaOption } from "@/lib/molit/apt";
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

export function applyPilotSingoga(params: {
  bundle: UnitTypeMasterBundle | null;
  deals: Array<{
    id: string;
    dealType: string;
    dealDate: string;
    dealAmount: number;
    exclusiveArea: number;
  }>;
}): Map<string, boolean> {
  const { bundle, deals } = params;
  if (!bundle || !isMarketGroupClass(bundle.classification.classification)) {
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
  return markSingogaMarketGroupPriorExceed(deals, groups);
}
