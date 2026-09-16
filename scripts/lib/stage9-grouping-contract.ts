/**
 * Shared Stage9–11 grouping contract helpers.
 *
 * CANDIDATE PIPELINE ORDER (mandatory):
 *   1. raw observed values
 *   2. areaKey canonicalization
 *   3. canonical dedupe
 *   4. candidate clustering
 *   5. group decision
 *
 * GLOBAL INVARIANT (not band-specific):
 *   similar-area group requires distinct canonical areas >= 2 AND min < max
 */
export type BandKey = "50-69" | "70-79" | "80-89" | "90-109" | "110+" | "other";
export type Decision = "SAFE_GROUP" | "AMBIGUOUS" | "NOT_GROUPABLE";

export type AreaRow = { exclusiveArea: number; txCount: number };

export type ClusterCand = {
  members: number[];
  min: number;
  max: number;
  span: number;
  maxGap: number;
  band: BandKey;
  txCounts: Record<string, number>;
  decision: Decision;
  reason: string;
  written: boolean;
  groupKey: string | null;
  linksInserted: number;
  aggregation: null;
  writePriority: number;
};

/** Existing repo precision (singoga.ts). */
export const areaKey = (sqm: number) => Math.round(sqm * 100) / 100;
export const areaKeyStr = (sqm: number) => String(areaKey(sqm));
export const fmtKeyArea = (sqm: number) => areaKey(sqm).toFixed(2);

export const HEURISTIC_MAX_SPAN = 0.2;
export const HEURISTIC_MAX_GAP = 0.15;

export function bandOf(area: number): BandKey {
  if (area >= 50 && area < 70) return "50-69";
  if (area >= 70 && area < 80) return "70-79";
  if (area >= 80 && area < 90) return "80-89";
  if (area >= 90 && area < 110) return "90-109";
  if (area >= 110) return "110+";
  return "other";
}

export function bandOfCluster(members: number[]): BandKey {
  const mid = (members[0]! + members[members.length - 1]!) / 2;
  return bandOf(mid);
}

export function dedupeAreas(areas: AreaRow[]): AreaRow[] {
  const map = new Map<string, AreaRow>();
  for (const a of areas) {
    const k = areaKeyStr(a.exclusiveArea);
    const ea = areaKey(a.exclusiveArea);
    const prev = map.get(k);
    if (prev) prev.txCount += a.txCount;
    else map.set(k, { exclusiveArea: ea, txCount: a.txCount });
  }
  return [...map.values()].sort((a, b) => a.exclusiveArea - b.exclusiveArea);
}

export function clusterAllBands(areasIn: AreaRow[]): ClusterCand[] {
  // ORDER: canonicalize + dedupe BEFORE clustering / decision
  const areas = dedupeAreas(areasIn);
  const sorted = areas.map((a) => a.exclusiveArea);
  const groups: number[][] = [];
  let cur: number[] = [];
  for (const ea of sorted) {
    if (cur.length === 0) {
      cur = [ea];
      continue;
    }
    if (ea - cur[0]! <= HEURISTIC_MAX_SPAN) cur.push(ea);
    else {
      groups.push(cur);
      cur = [ea];
    }
  }
  if (cur.length) groups.push(cur);

  const txMap = new Map(areas.map((a) => [areaKeyStr(a.exclusiveArea), a.txCount]));

  return groups.map((members) => {
    const span = areaKey(members[members.length - 1]! - members[0]!);
    let maxGap = 0;
    for (let i = 1; i < members.length; i++) {
      maxGap = Math.max(maxGap, areaKey(members[i]! - members[i - 1]!));
    }
    const txCounts: Record<string, number> = {};
    for (const m of members) txCounts[areaKeyStr(m)] = txMap.get(areaKeyStr(m)) ?? 0;
    const totalTx = Object.values(txCounts).reduce((s, n) => s + n, 0);
    const band = bandOfCluster(members);

    // GLOBAL INVARIANT first — never SAFE without distinct>=2 and min<max
    const contract = assertMinimumGroupContract(members);

    let decision: Decision;
    let reason: string;
    if (!contract.ok) {
      decision = "NOT_GROUPABLE";
      reason = `global invariant: ${contract.reason}`;
    } else if (span > HEURISTIC_MAX_SPAN + 1e-9) {
      decision = "NOT_GROUPABLE";
      reason = `span ${span} > heuristic ${HEURISTIC_MAX_SPAN}`;
    } else if (maxGap > HEURISTIC_MAX_GAP + 1e-9) {
      decision = "AMBIGUOUS";
      reason = `span ${span} ok but maxGap ${maxGap} > ${HEURISTIC_MAX_GAP}`;
    } else {
      decision = "SAFE_GROUP";
      reason = `multi-band candidate span=${span} maxGap=${maxGap} members=${members.length} band=${band}`;
    }

    const writePriority =
      (decision === "SAFE_GROUP" ? 1000 : 0) +
      members.length * 10 +
      Math.min(totalTx, 500) / 50;

    return {
      members,
      min: members[0]!,
      max: members[members.length - 1]!,
      span,
      maxGap,
      band,
      txCounts,
      decision,
      reason,
      written: false,
      groupKey: null,
      linksInserted: 0,
      aggregation: null,
      writePriority,
    };
  });
}

export function assertMinimumGroupContract(members: number[]): {
  ok: boolean;
  distinctCanonical: number;
  min: number | null;
  max: number | null;
  reason: string;
} {
  const canonical = [
    ...new Set(members.map((m) => areaKey(m))),
  ].sort((a, b) => a - b);
  if (canonical.length < 2) {
    return {
      ok: false,
      distinctCanonical: canonical.length,
      min: canonical[0] ?? null,
      max: canonical[0] ?? null,
      reason: "distinct canonical areas < 2",
    };
  }
  const min = canonical[0]!;
  const max = canonical[canonical.length - 1]!;
  if (!(min < max)) {
    return {
      ok: false,
      distinctCanonical: canonical.length,
      min,
      max,
      reason: "min canonical area must be < max",
    };
  }
  return {
    ok: true,
    distinctCanonical: canonical.length,
    min,
    max,
    reason: "minimum similar-area group contract satisfied",
  };
}

/**
 * Hard-cap selector: only NEW candidates consume budget.
 * alreadyExists=true → accepted without consuming remaining.
 * Deterministic by `order` ascending.
 */
export function proposeNewGroupsWithHardCap<
  T extends { id: string; alreadyExists: boolean; order: number },
>(candidates: T[], budget: number): { accepted: T[]; held: T[] } {
  const sorted = [...candidates].sort((a, b) => a.order - b.order);
  let remaining = budget;
  const accepted: T[] = [];
  const held: T[] = [];
  for (const c of sorted) {
    if (c.alreadyExists) {
      accepted.push(c);
      continue;
    }
    if (remaining <= 0) {
      held.push(c);
      continue;
    }
    accepted.push(c);
    remaining -= 1;
  }
  return { accepted, held };
}
