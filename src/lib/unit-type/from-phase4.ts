import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AptComplexClassification,
  AptPyeongGroupRow,
  AptUnitTypeGroupLinkRow,
  AptUnitTypeRow,
  UnitTypeClassification,
  UnitTypeMasterBundle,
} from "@/lib/unit-type/types";
import {
  PHASE5_PILOT_COMPLEXES,
  isMarketGroupClass,
  singogaModeForClass,
  type Phase5PilotComplex,
} from "@/lib/unit-type/pilot";
import { resolveGroupDisplayMode } from "@/lib/unit-type/labels";

type Phase4Json = {
  complex: { key: string; lawd_cd: string; apt_name_norm: string };
  gate: {
    classification: string;
    metrics: { label_confidence?: number };
    singoga_gate?: { mode?: string };
  };
  unit_types: Array<{
    unit_type_key: string;
    supply_area_sqm: number | null;
    exclusive_area_min: number;
    exclusive_area_max: number;
    household_count: number | null;
    mapping_confidence: string | null;
    exclusive_includes_partial_common: boolean;
  }>;
  candidate_pyeong_groups: Array<{
    group_key: string;
    market_label: number | null;
    supply_area_min: number | null;
    supply_area_max: number | null;
    exclusive_area_min: number;
    exclusive_area_max: number;
    household_count: number | null;
    confidence: string | null;
    group_confidence_high: boolean;
    label_null_reason: string | null;
  }>;
};

function overlayLabel(
  exclusiveMin: number,
  exclusiveMax: number,
  base: number | null,
  pilot: Phase5PilotComplex,
): number | null {
  if (!pilot.labelOverlays?.length) return base;
  const mid = (exclusiveMin + exclusiveMax) / 2;
  for (const o of pilot.labelOverlays) {
    if (mid >= o.exclusiveMin - 0.01 && mid <= o.exclusiveMax + 0.01) {
      return o.marketLabel;
    }
  }
  return base;
}

export function loadPhase4Bundle(
  pilot: Phase5PilotComplex,
  rootDir = process.cwd(),
): UnitTypeMasterBundle {
  const phase4 = JSON.parse(
    readFileSync(resolve(rootDir, pilot.phase4Path), "utf8"),
  ) as Phase4Json;
  const classification = pilot.pilotClass;
  const now = new Date().toISOString();

  const groups: AptPyeongGroupRow[] = phase4.candidate_pyeong_groups.map(
    (g, idx) => {
      const marketLabel = overlayLabel(
        g.exclusive_area_min,
        g.exclusive_area_max,
        g.market_label,
        pilot,
      );
      return {
        groupKey: g.group_key,
        complexKey: pilot.complexKey,
        marketLabel,
        displayMode: resolveGroupDisplayMode(classification, marketLabel),
        supplyAreaMin: g.supply_area_min,
        supplyAreaMax: g.supply_area_max,
        exclusiveAreaMin: g.exclusive_area_min,
        exclusiveAreaMax: g.exclusive_area_max,
        householdCount: g.household_count,
        confidence: g.confidence,
        groupConfidenceHigh: Boolean(g.group_confidence_high),
        labelNullReason: marketLabel == null ? g.label_null_reason : null,
        sortOrder: idx,
        source: "phase4",
      };
    },
  );

  const unitTypes: AptUnitTypeRow[] = phase4.unit_types.map((t) => ({
    unitTypeKey: t.unit_type_key,
    complexKey: pilot.complexKey,
    supplyAreaSqm: t.supply_area_sqm,
    exclusiveAreaMin: t.exclusive_area_min,
    exclusiveAreaMax: t.exclusive_area_max,
    householdCount: t.household_count,
    mappingConfidence: t.mapping_confidence,
    exclusiveIncludesPartialCommon: Boolean(
      t.exclusive_includes_partial_common,
    ),
    source: "phase4",
  }));

  const links: AptUnitTypeGroupLinkRow[] = [];
  for (const ut of unitTypes) {
    const mid = (ut.exclusiveAreaMin + ut.exclusiveAreaMax) / 2;
    const hit = groups.find(
      (g) =>
        mid >= g.exclusiveAreaMin - 0.005 && mid <= g.exclusiveAreaMax + 0.005,
    );
    if (hit) {
      links.push({
        unitTypeKey: ut.unitTypeKey,
        groupKey: hit.groupKey,
        complexKey: pilot.complexKey,
        isOutlier: false,
      });
    }
  }

  const classificationRow: AptComplexClassification = {
    complexKey: pilot.complexKey,
    aptNameNorm: pilot.aptNameNorm,
    lawdCd: pilot.lawdCd,
    gu: pilot.gu,
    classification,
    singogaMode: singogaModeForClass(classification),
    labelConfidence: phase4.gate.metrics.label_confidence ?? null,
    groupConfidenceHigh: isMarketGroupClass(classification),
    sourcePhase:
      pilot.complexKey === "banpo-xi" ? "phase4+phase45" : "phase4",
    provenanceJson: JSON.stringify({
      role: pilot.role,
      phase4Class: phase4.gate.classification,
      pilotClass: classification,
      phase4Singoga: phase4.gate.singoga_gate?.mode ?? null,
      rescued:
        pilot.complexKey === "banpo-xi"
          ? "phase45 housing-permit typeGb label rescue"
          : null,
    }),
    updatedAt: now,
  };

  return {
    classification: classificationRow,
    unitTypes,
    groups,
    links,
  };
}

export function dryRunPilotRowCounts(rootDir = process.cwd()): {
  classifications: number;
  unitTypes: number;
  groups: number;
  links: number;
  byComplex: Array<{
    complexKey: string;
    role: string;
    classification: UnitTypeClassification;
    unitTypes: number;
    groups: number;
    links: number;
  }>;
} {
  const byComplex = PHASE5_PILOT_COMPLEXES.map((pilot) => {
    const bundle = loadPhase4Bundle(pilot, rootDir);
    return {
      complexKey: pilot.complexKey,
      role: pilot.role,
      classification: bundle.classification.classification,
      unitTypes: bundle.unitTypes.length,
      groups: bundle.groups.length,
      links: bundle.links.length,
    };
  });
  return {
    classifications: byComplex.length,
    unitTypes: byComplex.reduce((s, r) => s + r.unitTypes, 0),
    groups: byComplex.reduce((s, r) => s + r.groups, 0),
    links: byComplex.reduce((s, r) => s + r.links, 0),
    byComplex,
  };
}
