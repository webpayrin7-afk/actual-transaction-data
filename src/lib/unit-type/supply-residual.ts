/** Deterministic residual identity and conflict classes. No address prose parsing. */

export const SUPPLY_CONFLICT_CLASSES = [
  "PRECISION_ONLY",
  "REAL_VARIANT",
  "OLDER_SOURCE",
  "IDENTITY_CONFLICT",
  "DERIVATION_CONFLICT",
  "UNKNOWN",
] as const;

export type SupplyConflictClass = (typeof SUPPLY_CONFLICT_CLASSES)[number];

export type DecodedParcel = {
  lawdCd: string;
  bjdongCd: string;
  platGbCd: string;
  bun: string;
  ji: string;
};

/** 19-digit PNU only. 10-digit legal codes and prose are rejected. */
export function decodeParcelPnu(pnu: string): DecodedParcel | null {
  const raw = pnu.trim();
  if (!/^\d{19}$/.test(raw)) return null;
  const platGbCd = raw.slice(10, 11);
  if (platGbCd !== "0" && platGbCd !== "1") return null;
  return {
    lawdCd: raw.slice(0, 5),
    bjdongCd: raw.slice(5, 10),
    platGbCd,
    bun: raw.slice(11, 15),
    ji: raw.slice(15, 19),
  };
}

export type IdentityVerdict = "IDENTITY_RECOVERED" | "IDENTITY_STILL_MISSING" | "IDENTITY_CONFLICT";

/**
 * Recover a parcel only when every internal 19-digit PNU agrees
 * and matches the complex lawd (and bjdong, when the complex has one).
 */
export function classifyInternalPnus(
  pnus: string[],
  lawdCd: string,
  bjdongCd: string,
): { status: IdentityVerdict; parcel: DecodedParcel | null; pnu: string } {
  const unique = [...new Set(pnus.map((pnu) => pnu.trim()).filter(Boolean))];
  if (unique.length === 0) return { status: "IDENTITY_STILL_MISSING", parcel: null, pnu: "" };
  const decoded = unique.map((pnu) => ({ pnu, parcel: decodeParcelPnu(pnu) }));
  if (decoded.some((row) => !row.parcel)) return { status: "IDENTITY_CONFLICT", parcel: null, pnu: "" };
  const parcels = decoded.map((row) => row.parcel!);
  const first = parcels[0]!;
  const agree = parcels.every(
    (parcel) =>
      parcel.lawdCd === first.lawdCd &&
      parcel.bjdongCd === first.bjdongCd &&
      parcel.platGbCd === first.platGbCd &&
      parcel.bun === first.bun &&
      parcel.ji === first.ji,
  );
  if (!agree) return { status: "IDENTITY_CONFLICT", parcel: null, pnu: "" };
  if (lawdCd && first.lawdCd !== lawdCd) return { status: "IDENTITY_CONFLICT", parcel: null, pnu: "" };
  if (bjdongCd && first.bjdongCd !== bjdongCd) return { status: "IDENTITY_CONFLICT", parcel: null, pnu: "" };
  return { status: "IDENTITY_RECOVERED", parcel: first, pnu: unique[0]! };
}

function asPairs(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  const pairs: Array<[number, number]> = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const exclusive = Number(item[0]);
    const supply = Number(item[1]);
    if (!Number.isFinite(exclusive) || !Number.isFinite(supply)) continue;
    pairs.push([exclusive, supply]);
  }
  return pairs;
}

/**
 * Classify a held conflict. Does not choose a supply and does not overwrite one.
 * REAL_VARIANT wins over PRECISION_ONLY when both appear.
 */
export function classifySupplyConflict(input: {
  exclusiveCents: number;
  heldSupplyCents: number;
  reason: string;
  provenanceJson: string;
}): SupplyConflictClass {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(input.provenanceJson || "{}") as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    return "UNKNOWN";
  }
  const incoming = asPairs(parsed.incoming);
  const heldExclusive = input.exclusiveCents / 100;
  const heldSupply = input.heldSupplyCents / 100;
  const nearExclusive = (exclusive: number) => Math.abs(exclusive - heldExclusive) < 0.02;
  const realVariant = incoming.some(
    ([exclusive, supply]) => nearExclusive(exclusive) && Math.abs(supply - heldSupply) > 0.05,
  );
  if (realVariant) return "REAL_VARIANT";
  if (input.reason === "GROUPED_DIFFERS_FROM_VERIFIED" || input.reason === "AMBIGUOUS_DIFFERS_FROM_VERIFIED") {
    return "DERIVATION_CONFLICT";
  }
  if (!incoming.length) return "OLDER_SOURCE";
  const precision = incoming.some(
    ([exclusive, supply]) => nearExclusive(exclusive) && Math.abs(supply - heldSupply) <= 0.05,
  );
  if (precision) return "PRECISION_ONLY";
  const exclusiveMismatch = incoming.every(([exclusive]) => Math.abs(exclusive - heldExclusive) >= 0.02);
  if (exclusiveMismatch) return "IDENTITY_CONFLICT";
  const formula = typeof parsed.formula === "string" ? parsed.formula : "";
  if (formula && formula !== "exclusive_plus_residential_common") return "DERIVATION_CONFLICT";
  return "UNKNOWN";
}

export function sameIncrementalSource(
  previous: { month: string; sha256: string } | null,
  next: { month: string; sha256: string },
): boolean {
  if (!previous) return false;
  return previous.month === next.month && previous.sha256 === next.sha256 && next.month !== "" && next.sha256 !== "";
}
