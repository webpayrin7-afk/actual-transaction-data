import { createHash } from "node:crypto";

/** Canonical building_id from official registry identity. Never a URL. */
export function buildingIdFromOfficialKey(officialKey: string): string {
  const key = officialKey.trim();
  if (!key) throw new Error("official building key required");
  const hex = createHash("sha256")
    .update(`bldrgst:${key}`)
    .digest("hex")
    .slice(0, 16);
  return `bd_${hex}`;
}

export function officialKeyFromTitlePk(mgmBldrgstPk: string | number): string | null {
  const pk = String(mgmBldrgstPk ?? "").trim();
  if (!/^\d{6,32}$/.test(pk)) return null;
  return pk;
}

export function areaCents(area: number): number {
  if (!Number.isFinite(area)) return -1;
  return Math.round((area + 1e-12) * 100);
}

export function areaFromCents(cents: number): number {
  return cents / 100;
}
