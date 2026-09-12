import type { UnitTypeClassification } from "@/lib/unit-type/types";

export type PilotRole = "A" | "B" | "C" | "D";

export type LabelOverlay = {
  exclusiveMin: number;
  exclusiveMax: number;
  marketLabel: number;
};

export type Phase5PilotComplex = {
  complexKey: string;
  aptNameNorm: string;
  lawdCd: string;
  gu: string;
  role: PilotRole;
  phase4Class: UnitTypeClassification;
  pilotClass: UnitTypeClassification;
  phase4Path: string;
  labelOverlays?: LabelOverlay[];
};

/** Phase 5 production pilot allowlist only. Nationwide backfill forbidden. */
export const PHASE5_PILOT_COMPLEXES: Phase5PilotComplex[] = [
  {
    complexKey: "hangang-daewoo",
    aptNameNorm: "한강(대우)",
    lawdCd: "11170",
    gu: "용산구",
    role: "A",
    phase4Class: "auto-safe",
    pilotClass: "auto-safe",
    phase4Path: "data/poc/phase4/hangang-daewoo-phase4.json",
  },
  {
    complexKey: "parkrio",
    aptNameNorm: "파크리오",
    lawdCd: "11710",
    gu: "송파구",
    role: "A",
    phase4Class: "auto-safe",
    pilotClass: "auto-safe",
    phase4Path: "data/poc/phase4/parkrio-phase4.json",
  },
  {
    complexKey: "banpo-xi",
    aptNameNorm: "반포자이",
    lawdCd: "11650",
    gu: "서초구",
    role: "A",
    phase4Class: "group-safe-label-unknown",
    pilotClass: "auto-safe",
    phase4Path: "data/poc/phase4/banpo-xi-phase4.json",
    labelOverlays: [
      { exclusiveMin: 84.94, exclusiveMax: 85.0, marketLabel: 35 },
      { exclusiveMin: 132.18, exclusiveMax: 132.44, marketLabel: 50 },
      { exclusiveMin: 165.05, exclusiveMax: 165.45, marketLabel: 60 },
      { exclusiveMin: 194.52, exclusiveMax: 194.69, marketLabel: 70 },
      { exclusiveMin: 216.49, exclusiveMax: 216.49, marketLabel: 80 },
    ],
  },
  {
    complexKey: "jamsil-els",
    aptNameNorm: "잠실엘스",
    lawdCd: "11710",
    gu: "송파구",
    role: "B",
    phase4Class: "group-safe-label-unknown",
    pilotClass: "group-safe-label-unknown",
    phase4Path: "data/poc/phase4/jamsil-els-phase4.json",
  },
  {
    complexKey: "mokdong-7",
    aptNameNorm: "목동신시가지7",
    lawdCd: "11470",
    gu: "양천구",
    role: "C",
    phase4Class: "ambiguous",
    pilotClass: "ambiguous",
    phase4Path: "data/poc/phase4/mokdong-7-phase4.json",
  },
  {
    complexKey: "eunma",
    aptNameNorm: "은마",
    lawdCd: "11680",
    gu: "강남구",
    role: "D",
    phase4Class: "registry-abnormal",
    pilotClass: "registry-abnormal",
    phase4Path: "data/poc/phase4/eunma-phase4.json",
  },
];

export function isMarketGroupClass(
  classification: UnitTypeClassification,
): boolean {
  return (
    classification === "auto-safe" ||
    classification === "group-safe-label-unknown"
  );
}

export function singogaModeForClass(
  classification: UnitTypeClassification,
): "market_group" | "exclusive_area_fallback" {
  return isMarketGroupClass(classification)
    ? "market_group"
    : "exclusive_area_fallback";
}

export function pilotByAptNameNorm(
  aptNameNorm: string,
): Phase5PilotComplex | undefined {
  const key = aptNameNorm.replace(/\s+/g, "");
  return PHASE5_PILOT_COMPLEXES.find((c) => c.aptNameNorm === key);
}
