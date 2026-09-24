/**
 * KAPT list ↔ Apartment Master resolver (M2/M3).
 * Deterministic tiers only — no fuzzy-only auto-match.
 */
export type KaptListItem = {
  kaptCode: string;
  kaptName: string;
  bjdCode: string;
  as1?: string;
  as2?: string;
  as3?: string;
  as4?: string;
};

export type MasterRow = {
  complexId: string;
  aptName: string;
  aptNameNorm: string;
  lawdCd: string;
  bjdongCd: string | null;
  jibun: string | null;
  sigungu: string;
  legalDongName: string | null;
};

export type MatchTier =
  | "EXACT_SAFE"
  | "HIGH_CONFIDENCE"
  | "AMBIGUOUS"
  | "KAPT_ONLY"
  | "MASTER_ONLY";

export type Pair = {
  master: MasterRow;
  kapt: KaptListItem;
  tier: "EXACT_SAFE" | "HIGH_CONFIDENCE";
  evidence: string;
};

export const RESOLVER_VERSION = "kapt_identity_resolver_v2";

export function normalizeName(s: string): string {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[()[\]{}·・･]/g, "")
    .trim()
    .toLowerCase();
}

export function namesCompatible(a: string, b: string): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) {
    return true;
  }
  return false;
}

/** KAPT name ends with master name (e.g. 잠실리센츠 ↔ 리센츠), min master len 3. */
export function kaptEndsWithMasterName(masterName: string, kaptName: string): boolean {
  const m = normalizeName(masterName);
  const k = normalizeName(kaptName);
  if (m.length < 3 || k.length <= m.length) return false;
  return k.endsWith(m) && k !== m;
}

export function fullBjd(lawdCd: string, bjdongCd: string | null): string | null {
  if (!lawdCd || lawdCd.length < 5) return null;
  if (!bjdongCd) return null;
  if (bjdongCd.length >= 10) return bjdongCd;
  return `${lawdCd.slice(0, 5)}${bjdongCd}`;
}

export function dongCompatible(
  master: MasterRow,
  kapt: KaptListItem,
): boolean {
  const as3 = normalizeName(kapt.as3 ?? "");
  const legal = normalizeName(master.legalDongName ?? "");
  if (as3 && legal && as3 === legal) return true;
  return false;
}

export function matchDistrict(
  masters: MasterRow[],
  kapts: KaptListItem[],
): {
  pairs: Pair[];
  ambiguousMaster: string[];
  ambiguousKapt: string[];
  masterOnly: string[];
  kaptOnly: string[];
  counts: Record<MatchTier, number>;
} {
  const byBjd = new Map<string, KaptListItem[]>();
  for (const k of kapts) {
    const b = String(k.bjdCode ?? "");
    if (!b) continue;
    const arr = byBjd.get(b) ?? [];
    arr.push(k);
    byBjd.set(b, arr);
  }

  const assignedMaster = new Set<string>();
  const assignedKapt = new Set<string>();
  const pairs: Pair[] = [];
  const ambiguousMaster: string[] = [];
  const ambiguousKaptCodes = new Set<string>();

  const pushAmb = (mId: string, ks: KaptListItem[]) => {
    ambiguousMaster.push(mId);
    for (const k of ks) ambiguousKaptCodes.add(k.kaptCode);
  };

  // Pass 1: EXACT_SAFE — normalized name exact + bjd unique
  for (const m of masters) {
    const bjd = fullBjd(m.lawdCd, m.bjdongCd);
    if (!bjd) continue;
    const pool = byBjd.get(bjd) ?? [];
    const exact = pool.filter(
      (k) => normalizeName(k.kaptName) === normalizeName(m.aptName),
    );
    if (exact.length === 1) {
      const k = exact[0]!;
      if (!assignedKapt.has(k.kaptCode) && !assignedMaster.has(m.complexId)) {
        pairs.push({
          master: m,
          kapt: k,
          tier: "EXACT_SAFE",
          evidence: `exact_name+bjd(${bjd})`,
        });
        assignedMaster.add(m.complexId);
        assignedKapt.add(k.kaptCode);
      }
    } else if (exact.length > 1) {
      pushAmb(m.complexId, exact);
    }
  }

  // Pass 2: HIGH_CONFIDENCE — name compatible + bjd, unique
  for (const m of masters) {
    if (assignedMaster.has(m.complexId)) continue;
    const bjd = fullBjd(m.lawdCd, m.bjdongCd);
    if (!bjd) continue;
    const pool = (byBjd.get(bjd) ?? []).filter(
      (k) => !assignedKapt.has(k.kaptCode),
    );
    const compat = pool.filter((k) => namesCompatible(m.aptName, k.kaptName));
    if (compat.length === 1) {
      const k = compat[0]!;
      pairs.push({
        master: m,
        kapt: k,
        tier: "HIGH_CONFIDENCE",
        evidence: `name_compatible+bjd(${bjd}); master=${m.aptName}; kapt=${k.kaptName}`,
      });
      assignedMaster.add(m.complexId);
      assignedKapt.add(k.kaptCode);
    } else if (compat.length > 1) {
      pushAmb(m.complexId, compat);
    }
  }

  // Pass 3 (V2): locality-prefix / suffix with dong agreement
  // e.g. 리센츠 ↔ 잠실리센츠 when same bjd AND as3 === legal_dong_name AND unique
  for (const m of masters) {
    if (assignedMaster.has(m.complexId)) continue;
    const bjd = fullBjd(m.lawdCd, m.bjdongCd);
    if (!bjd) continue;
    if (!m.legalDongName) continue;
    const pool = (byBjd.get(bjd) ?? []).filter(
      (k) => !assignedKapt.has(k.kaptCode),
    );
    const suffixHits = pool.filter(
      (k) =>
        kaptEndsWithMasterName(m.aptName, k.kaptName) &&
        dongCompatible(m, k),
    );
    if (suffixHits.length === 1) {
      const k = suffixHits[0]!;
      // Ensure no other unassigned master in same bjd also suffix-matches this kapt
      const competing = masters.filter((om) => {
        if (om.complexId === m.complexId) return false;
        if (assignedMaster.has(om.complexId)) return false;
        const ob = fullBjd(om.lawdCd, om.bjdongCd);
        if (ob !== bjd) return false;
        return (
          kaptEndsWithMasterName(om.aptName, k.kaptName) &&
          dongCompatible(om, k)
        );
      });
      if (competing.length === 0) {
        pairs.push({
          master: m,
          kapt: k,
          tier: "HIGH_CONFIDENCE",
          evidence: `suffix_name+bjd+dong(${m.legalDongName}); master=${m.aptName}; kapt=${k.kaptName}`,
        });
        assignedMaster.add(m.complexId);
        assignedKapt.add(k.kaptCode);
      } else {
        pushAmb(m.complexId, suffixHits);
      }
    } else if (suffixHits.length > 1) {
      pushAmb(m.complexId, suffixHits);
    }
  }

  const ambMasters = [...new Set(ambiguousMaster)].filter(
    (id) => !assignedMaster.has(id),
  );
  const masterOnly = masters
    .filter(
      (m) =>
        !assignedMaster.has(m.complexId) && !ambMasters.includes(m.complexId),
    )
    .map((m) => m.complexId);
  const kaptOnly = kapts
    .filter(
      (k) =>
        !assignedKapt.has(k.kaptCode) && !ambiguousKaptCodes.has(k.kaptCode),
    )
    .map((k) => k.kaptCode);

  const counts: Record<MatchTier, number> = {
    EXACT_SAFE: pairs.filter((p) => p.tier === "EXACT_SAFE").length,
    HIGH_CONFIDENCE: pairs.filter((p) => p.tier === "HIGH_CONFIDENCE").length,
    AMBIGUOUS: ambMasters.length,
    KAPT_ONLY: kaptOnly.length,
    MASTER_ONLY: masterOnly.length,
  };

  return {
    pairs,
    ambiguousMaster: ambMasters,
    ambiguousKapt: [...ambiguousKaptCodes],
    masterOnly,
    kaptOnly,
    counts,
  };
}
