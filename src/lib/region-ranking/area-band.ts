/**
 * Regional comparison bands. Separate from apt_pyeong_groups.
 * apt_pyeong_groups stay per-complex unit clusters and are not rewritten here.
 *
 * REGIONAL_RANKING_AREA_BAND_V1 band "84" is the window that reproduces the
 * cited Songpa warehouse counts (헬리오시티 94, 주공아파트5단지 54) on the
 * trailing 12 months ending 2026-09-17. The later 82–87 retest is a different
 * band: it drops 주공아파트5단지 to 43 because 81.8㎡ rows fall outside.
 */

export const AREA_BAND_VERSION = "REGIONAL_RANKING_AREA_BAND_V1";

export type AreaBandStatus = "active" | "future" | "rejected_alternate";

export type AreaBandDef = {
  id: "59" | "84" | "114" | "ALL";
  status: AreaBandStatus;
  /** Inclusive exclusive-area bounds. Absent until the band is frozen. */
  exclusiveSqmMin?: number;
  exclusiveSqmMax?: number;
  note: string;
};

export const AREA_BANDS_V1: readonly AreaBandDef[] = [
  {
    id: "84",
    status: "active",
    exclusiveSqmMin: 80,
    exclusiveSqmMax: 90,
    note: "Inclusive exclusive_area. Reproduces the cited 12-month warehouse counts. Not an apt_pyeong_groups label.",
  },
  {
    id: "59",
    status: "future",
    note: "Bounds not frozen. Do not mix raw deals into 84.",
  },
  {
    id: "114",
    status: "future",
    note: "Bounds not frozen. Do not mix raw deals into 84.",
  },
  {
    id: "ALL",
    status: "future",
    note: "Future band-score aggregation only. Raw transactions from different bands must not be pooled.",
  },
];

export const REJECTED_84_ALTERNATE = {
  id: "84-retest-82-87",
  status: "rejected_alternate" as const,
  exclusiveSqmMin: 82,
  exclusiveSqmMax: 87,
  note: "Later POC retest expression. Not equivalent to BAND_V1 84 on 주공아파트5단지.",
};

export function activeAreaBand(id: "84"): AreaBandDef {
  const band = AREA_BANDS_V1.find((row) => row.id === id);
  if (!band || band.exclusiveSqmMin == null || band.exclusiveSqmMax == null) {
    throw new Error(`area band ${id} is not active`);
  }
  return band;
}

export function inAreaBand(exclusiveSqm: number, band: AreaBandDef): boolean {
  if (band.exclusiveSqmMin == null || band.exclusiveSqmMax == null) return false;
  return exclusiveSqm >= band.exclusiveSqmMin && exclusiveSqm <= band.exclusiveSqmMax;
}
