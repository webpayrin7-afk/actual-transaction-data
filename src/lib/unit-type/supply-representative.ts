import type { Client } from "@libsql/client";
import { areaFromCents, canonicalSupplyPyeong } from "@/lib/unit-type/canonical";

/** Pick the representative supply inside one exclusive area. Household count required. */

export type SupplyVariantCount = {
  supplyCents: number;
  householdCount: number | null;
};

export type RepresentativePick = {
  representativeSupplyCents: number;
  representativeHouseholdCount: number;
  variants: Array<{ supplyCents: number; householdCount: number }>;
};

/**
 * Most households wins. A tie takes the smaller supply.
 * Missing household count, or fewer than two supplies, is a hold (null).
 */
export function pickRepresentativeSupply(variants: SupplyVariantCount[]): RepresentativePick | null {
  const unique = new Map<number, number | null>();
  for (const variant of variants) {
    if (!Number.isInteger(variant.supplyCents) || variant.supplyCents < 0) continue;
    const prev = unique.get(variant.supplyCents);
    if (prev == null) unique.set(variant.supplyCents, variant.householdCount);
  }
  if (unique.size < 2) return null;
  const items: Array<{ supplyCents: number; householdCount: number }> = [];
  for (const [supplyCents, householdCount] of unique) {
    if (householdCount == null || !Number.isInteger(householdCount) || householdCount < 0) return null;
    items.push({ supplyCents, householdCount });
  }
  items.sort((a, b) => b.householdCount - a.householdCount || a.supplyCents - b.supplyCents);
  const winner = items[0]!;
  const stored = [...items].sort((a, b) => a.supplyCents - b.supplyCents);
  return {
    representativeSupplyCents: winner.supplyCents,
    representativeHouseholdCount: winner.householdCount,
    variants: stored,
  };
}

export type StoredSupplyRepresentative = RepresentativePick & {
  complexId: string;
  exclusiveCents: number;
  /** Integer 평 range across variants, e.g. "33~34평". */
  pyeongRangeLabel: string;
};

function pyeongLabel(supplyCents: number): number {
  return Math.round(canonicalSupplyPyeong(areaFromCents(supplyCents)));
}

export function pyeongRangeLabel(supplyCents: number[]): string {
  const labels = [...new Set(supplyCents.map(pyeongLabel))].sort((a, b) => a - b);
  if (labels.length === 0) return "";
  if (labels.length === 1) return `${labels[0]}평`;
  return `${labels[0]}~${labels[labels.length - 1]}평`;
}

/** Representative row plus every variant supply and its household count. */
export async function listSupplyRepresentatives(
  db: Client,
  complexId: string,
): Promise<StoredSupplyRepresentative[]> {
  const res = await db.execute({
    sql: `SELECT exclusive_cents, representative_supply_cents, representative_household_count, variants_json
          FROM apt_unit_supply_representative WHERE complex_id = ? ORDER BY exclusive_cents`,
    args: [complexId],
  });
  return res.rows.map((row) => {
    const variants = JSON.parse(String(row.variants_json)) as Array<{ supplyCents: number; householdCount: number }>;
    return {
      complexId,
      exclusiveCents: Number(row.exclusive_cents),
      representativeSupplyCents: Number(row.representative_supply_cents),
      representativeHouseholdCount: Number(row.representative_household_count),
      variants,
      pyeongRangeLabel: pyeongRangeLabel(variants.map((variant) => variant.supplyCents)),
    };
  });
}
