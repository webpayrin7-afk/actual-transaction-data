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

/**
 * 59 and 114 use the same offsets as the locked 84 window.
 * Seoul 12M trade modes are 59, 84, and 114. Each window is [mode-4, mode+6].
 * The windows do not overlap. 49㎡ and 101㎡ stay outside.
 */
export const AREA_BANDS_V1: readonly AreaBandDef[] = [
  {
    id: "59",
    status: "active",
    exclusiveSqmMin: 55,
    exclusiveSqmMax: 65,
    note: "Inclusive exclusive_area around the Seoul 59㎡ mode. Does not include the separate 49㎡ mode.",
  },
  {
    id: "84",
    status: "active",
    exclusiveSqmMin: 80,
    exclusiveSqmMax: 90,
    note: "Inclusive exclusive_area. Reproduces the cited 12-month warehouse counts. Not an apt_pyeong_groups label.",
  },
  {
    id: "114",
    status: "active",
    exclusiveSqmMin: 110,
    exclusiveSqmMax: 120,
    note: "Inclusive exclusive_area around the Seoul 114㎡ mode. Does not include the 101㎡ or 134㎡ modes.",
  },
  {
    id: "ALL",
    status: "future",
    note: "Band-score aggregation only. Raw transactions from different bands must not be pooled.",
  },
];

export const REJECTED_84_ALTERNATE = {
  id: "84-retest-82-87",
  status: "rejected_alternate" as const,
  exclusiveSqmMin: 82,
  exclusiveSqmMax: 87,
  note: "Later POC retest expression. Not equivalent to BAND_V1 84 on 주공아파트5단지.",
};

export function activeAreaBand(id: "59" | "84" | "114"): AreaBandDef {
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

export type RegionalAreaBandId = "59" | "84" | "114";

/**
 * Selected exclusive area → regional band.
 * Uses the frozen inclusive windows only. No nearest-band rounding.
 * Not apt_pyeong_groups and not the 84.00–84.99 selector helper.
 */
export function resolveSelectedAreaBand(exclusiveSqm: number): RegionalAreaBandId | null {
  if (!Number.isFinite(exclusiveSqm)) return null;
  const ids: readonly RegionalAreaBandId[] = ["59", "84", "114"];
  for (const id of ids) {
    if (inAreaBand(exclusiveSqm, activeAreaBand(id))) return id;
  }
  return null;
}
