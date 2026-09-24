/**
 * Ranking V3 read-only constants and decade helpers.
 * Does not score, publish, or change eligibility.
 */
export const RANKING_V3_VERSION = "seoul-ranking-v3";
export const AREA_BAND_VERSION_V3 = "SUPPLY_PYEONG_DECADE_V1";

export const DECADE_COHORTS_V3 = [
  { key: "10", min: 10, max: 20, label: "10평대" },
  { key: "20", min: 20, max: 30, label: "20평대" },
  { key: "30", min: 30, max: 40, label: "30평대" },
  { key: "40", min: 40, max: 50, label: "40평대" },
  { key: "50", min: 50, max: 60, label: "50평대" },
  { key: "60", min: 60, max: 70, label: "60평대" },
  { key: "70", min: 70, max: 80, label: "70평대" },
  { key: "80", min: 80, max: 90, label: "80평대" },
  { key: "90", min: 90, max: 100, label: "90평대" },
  { key: "100", min: 100, max: 10000, label: "100평+" },
] as const;

export type DecadeCohortV3 = (typeof DECADE_COHORTS_V3)[number];
export type DecadeKeyV3 = DecadeCohortV3["key"];

export const DECADE_KEYS_V3 = new Set<string>(DECADE_COHORTS_V3.map((row) => row.key));

export function decadeCohortForLabel(label: number): DecadeCohortV3 | null {
  if (!Number.isFinite(label) || label <= 0) return null;
  return DECADE_COHORTS_V3.find((cohort) => label >= cohort.min && label < cohort.max) ?? null;
}

export function decadeCohortByKey(key: string): DecadeCohortV3 | null {
  return DECADE_COHORTS_V3.find((cohort) => cohort.key === key) ?? null;
}

export function parseSelectedMarketPyeongLabel(
  raw: string | number | null | undefined,
): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const label = Math.round(n);
  return label > 0 ? label : null;
}
