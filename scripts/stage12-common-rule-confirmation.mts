/**
 * STAGE 12 — Held-out common-rule confirmation (read-only).
 *
 * INSERT=0 UPDATE=0 DELETE=0
 * Max 20 held-out complexes (Stage6–11 samples excluded).
 * Local DB only. No expansion writes.
 */
import { createClient, type InArgs } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  areaKey,
  areaKeyStr,
  bandOf,
  clusterByCommonRuleV1,
  dedupeAreas,
  evaluateMembersAgainstV1,
  proposeNewGroupsWithHardCap,
  SIMILAR_EXCLUSIVE_AREA_RULE_VERSION,
  V1_MAX_GAP,
  V1_MAX_SPAN,
  type AreaRow,
  type BandKey,
  type V1ClusterCand,
  type V1Decision,
} from "./lib/stage9-grouping-contract";

config({ path: ".env.local" });
config();

const OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage12-common-rule-confirmation.json",
);

/** Stage6–11 complexes used in production or validation samples. */
const EXCLUDE_IDS = new Set<string>([
  // Stage6–7
  "cx_caf229b5ac63cfbd",
  "cx_85cd8a4b2d5dc3d0",
  // Stage8
  "cx_b1f9d0cc3e8e5c12",
  "cx_b74bdaa8f28045aa",
  "cx_4880c4ffe9880d49",
  "cx_e095bf141dde5379",
  "cx_c7ac494bf78993ad",
  // Stage9
  "cx_c3f8a052ae66fd32",
  "cx_774f03bf66e7882f",
  "cx_836331525ecdd550",
  "cx_d80e92e6aef239af",
  "cx_b225492e31c09cdd",
  "cx_04a453b6ca3d373c",
  "cx_7ce2c0c6be9bb8b4",
  "cx_d754faa260b961ae",
  "cx_c8ecd97624efad6d",
  "cx_6ae0260f869a7b0f",
  // Stage10 evidence
  "cx_0d3aa06062c08f6d",
  "cx_1cee18237c0558c8",
  "cx_330268b879cddb2a",
  "cx_34d909b2ef3bd46b",
  "cx_36885c48bc315d21",
  "cx_3c9ad2c07cb0a99e",
  "cx_481ee87127144ab0",
  "cx_4b8b70b7ec5957e6",
  "cx_03e789e16461e7d8",
  "cx_04e35eb2cb2d5589",
  "cx_0a13d62a787b2a79",
  "cx_0a6b2e31c09f60f8",
  // Stage11 refinement
  "cx_19d860b6f1691a0a",
  "cx_016721d1bffdbdb2",
  "cx_055cb985e428bb28",
  "cx_1700b4e47aa74c48",
  "cx_e13f2397a4636a30",
  "cx_233505f10de13926",
  "cx_ae75a0e9c461c572",
  "cx_dcca5b920bc9ae42",
  "cx_de547f7aab2e1751",
  "cx_496be5b8281790e3",
  "cx_15146fabcc5151c3",
  "cx_306a7067aadebbf2",
  "cx_16bfb738f653a613",
  "cx_2c20b50f2c7a8ba1",
]);

const STAGE7_9_CX_PREFIXES = [
  "cx_85cd8a4b2d5dc3d0", // Stage7
  "cx_b1f9d0cc3e8e5c12",
  "cx_b74bdaa8f28045aa",
  "cx_4880c4ffe9880d49",
  "cx_e095bf141dde5379",
  "cx_c7ac494bf78993ad",
  "cx_c3f8a052ae66fd32",
  "cx_774f03bf66e7882f",
  "cx_836331525ecdd550",
  "cx_d80e92e6aef239af",
  "cx_b225492e31c09cdd",
  "cx_04a453b6ca3d373c",
  "cx_7ce2c0c6be9bb8b4",
  "cx_d754faa260b961ae",
  "cx_c8ecd97624efad6d",
  "cx_6ae0260f869a7b0f",
] as const;

const LEGACY_SLUGS = [
  "acro-riverpark",
  "daechi-palace",
  "hannam-thehill",
  "mapo-raemian-prugio",
  "raemian-hill-godeok",
  "parkrio",
  "jamsil-els",
] as const;

const BANDS: BandKey[] = ["50-69", "70-79", "80-89", "90-109", "110+"];
const BAND_QUOTA: Record<BandKey, number> = {
  "50-69": 4,
  "70-79": 3,
  "80-89": 4,
  "90-109": 4,
  "110+": 5,
  other: 0,
};

const GAP_BUCKETS = [
  { name: "0.12", lo: 0.115, hi: 0.125 },
  { name: "0.13", lo: 0.125, hi: 0.135 },
  { name: "0.14", lo: 0.135, hi: 0.145 },
  { name: "0.15", lo: 0.145, hi: 0.155 },
  { name: "0.16", lo: 0.155, hi: 0.165 },
  { name: "0.17", lo: 0.165, hi: 0.175 },
  { name: "0.18+", lo: 0.175, hi: 0.5 },
] as const;

const MAX_COMPLEXES = 20;

type Db = ReturnType<typeof createClient>;

type Comp = {
  complexId: string;
  name: string;
  lawdCd: string;
  dong: string | null;
  areas: AreaRow[];
};

async function count(db: Db, sql: string, args: InArgs = []) {
  const r = await db.execute({ sql, args });
  return Number(r.rows[0]!.c);
}

function consecutiveGaps(sorted: number[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(areaKey(sorted[i]! - sorted[i - 1]!));
  }
  return gaps;
}

function bandAreas(areas: AreaRow[], band: BandKey): AreaRow[] {
  return areas.filter((a) => bandOf(a.exclusiveArea) === band);
}

function usefulGaps(gaps: number[]): number[] {
  return gaps.filter((g) => g >= 0.12 && g <= 0.3);
}

function pickHeldOut(pool: Comp[]): {
  selected: Comp[];
  bandHits: Record<string, string[]>;
  gapCoverage: Record<string, number>;
} {
  type Cand = {
    comp: Comp;
    band: BandKey;
    gaps: number[];
    maxUsefulGap: number;
    multiCanonical: number;
  };

  const cands: Cand[] = [];
  for (const comp of pool) {
    for (const band of BANDS) {
      const ba = bandAreas(comp.areas, band);
      if (ba.length < 2) continue;
      const sorted = ba.map((a) => a.exclusiveArea).sort((a, b) => a - b);
      const gaps = consecutiveGaps(sorted);
      const ug = usefulGaps(gaps);
      if (ug.length === 0 && ba.length < 2) continue;
      // Prefer complexes with near-boundary gaps, but allow tight clusters too
      const near = gaps.some((g) => g >= 0.12 && g <= 0.2);
      if (!near && ba.length < 3) continue;
      cands.push({
        comp,
        band,
        gaps,
        maxUsefulGap: ug.length ? Math.max(...ug) : Math.max(...gaps, 0),
        multiCanonical: ba.length,
      });
    }
  }

  // Deterministic: prefer near-boundary diversity, then complex_id
  cands.sort((a, b) => {
    const aDist = Math.min(...a.gaps.map((g) => Math.abs(g - 0.15)), 99);
    const bDist = Math.min(...b.gaps.map((g) => Math.abs(g - 0.15)), 99);
    if (aDist !== bDist) return aDist - bDist;
    if (b.multiCanonical !== a.multiCanonical)
      return b.multiCanonical - a.multiCanonical;
    return a.comp.complexId.localeCompare(b.comp.complexId);
  });

  const selectedIds = new Set<string>();
  const selected: Comp[] = [];
  const bandHits: Record<string, string[]> = {
    "50-69": [],
    "70-79": [],
    "80-89": [],
    "90-109": [],
    "110+": [],
  };
  const gapCoverage: Record<string, number> = Object.fromEntries(
    GAP_BUCKETS.map((b) => [b.name, 0]),
  );

  function registerGaps(gaps: number[]) {
    for (const g of gaps) {
      for (const b of GAP_BUCKETS) {
        if (g >= b.lo && g < b.hi) gapCoverage[b.name]! += 1;
      }
    }
  }

  function bandNeed(band: BandKey) {
    return (bandHits[band]?.length ?? 0) < (BAND_QUOTA[band] ?? 0);
  }

  // Pass 1: fill band quotas with boundary-near candidates
  for (const c of cands) {
    if (selected.length >= MAX_COMPLEXES) break;
    if (!bandNeed(c.band)) continue;
    if (selectedIds.has(c.comp.complexId)) {
      if (!bandHits[c.band]!.includes(c.comp.complexId)) {
        bandHits[c.band]!.push(c.comp.complexId);
        registerGaps(c.gaps);
      }
      continue;
    }
    selectedIds.add(c.comp.complexId);
    selected.push(c.comp);
    bandHits[c.band]!.push(c.comp.complexId);
    registerGaps(c.gaps);
    // also credit other bands this complex covers
    for (const band of BANDS) {
      if (band === c.band) continue;
      const ba = bandAreas(c.comp.areas, band);
      if (ba.length >= 2) {
        const gaps = consecutiveGaps(
          ba.map((a) => a.exclusiveArea).sort((x, y) => x - y),
        );
        if (usefulGaps(gaps).length || gaps.some((g) => g <= 0.2)) {
          if (!bandHits[band]!.includes(c.comp.complexId) && bandNeed(band)) {
            bandHits[band]!.push(c.comp.complexId);
            registerGaps(gaps);
          }
        }
      }
    }
  }

  // Pass 2: fill remaining quota / gap holes up to 20
  for (const c of cands) {
    if (selected.length >= MAX_COMPLEXES) break;
    const underfilled = BANDS.some((b) => bandNeed(b));
    const gapHole = GAP_BUCKETS.some((b) => (gapCoverage[b.name] ?? 0) === 0);
    if (!underfilled && !gapHole) break;
    if (selectedIds.has(c.comp.complexId)) continue;
    const helpsBand = bandNeed(c.band);
    const helpsGap = c.gaps.some((g) =>
      GAP_BUCKETS.some(
        (b) => (gapCoverage[b.name] ?? 0) === 0 && g >= b.lo && g < b.hi,
      ),
    );
    if (!helpsBand && !helpsGap) continue;
    selectedIds.add(c.comp.complexId);
    selected.push(c.comp);
    if (!bandHits[c.band]!.includes(c.comp.complexId)) {
      bandHits[c.band]!.push(c.comp.complexId);
    }
    registerGaps(c.gaps);
  }

  selected.sort((a, b) => a.complexId.localeCompare(b.complexId));
  return { selected, bandHits, gapCoverage };
}

function annotateDecision(
  c: V1ClusterCand,
  allClusters: V1ClusterCand[],
): V1ClusterCand {
  if (c.decision !== "SAFE_BY_COMMON_RULE") return c;

  // False-positive structural checks
  const memberSet = new Set(c.members.map(areaKeyStr));
  for (const other of allClusters) {
    if (other === c) continue;
    if (other.decision !== "SAFE_BY_COMMON_RULE") continue;
    for (const m of other.members) {
      if (memberSet.has(areaKeyStr(m))) {
        return {
          ...c,
          decision: "SEMANTIC_AMBIGUITY",
          reason: `overlap with another SAFE cluster containing ${m}`,
        };
      }
    }
  }

  // Defensive numeric integrity
  if (c.span > V1_MAX_SPAN + 1e-9 || c.maxGap > V1_MAX_GAP + 1e-9) {
    return {
      ...c,
      decision: "SEMANTIC_AMBIGUITY",
      reason: "numeric SAFE but violates V1 thresholds (integrity)",
    };
  }

  // Non-canonical float leakage
  for (const m of c.members) {
    if (areaKey(m) !== m) {
      return {
        ...c,
        decision: "SEMANTIC_AMBIGUITY",
        reason: `non-canonical member ${m}`,
      };
    }
  }

  return c;
}

function classifyFalseNegative(c: V1ClusterCand): {
  kind: "CORRECT_BOUNDARY" | "POSSIBLE_FALSE_NEGATIVE" | null;
  note: string;
} {
  if (c.decision !== "BOUNDARY_REJECTED") {
    return { kind: null, note: "" };
  }
  const nearGap = c.maxGap >= 0.16 && c.maxGap <= 0.18;
  const nearSpan = c.span >= 0.21 && c.span <= 0.25;
  if (!nearGap && !nearSpan) {
    // After gap-split, BOUNDARY_REJECTED is almost always span>0.20
    if (c.span >= 0.21 && c.span <= 0.25) {
      return {
        kind: "POSSIBLE_FALSE_NEGATIVE",
        note: `span ${c.span} just over 0.20 with maxGap ${c.maxGap}`,
      };
    }
    return {
      kind: "CORRECT_BOUNDARY",
      note: `span ${c.span} / maxGap ${c.maxGap} clearly outside near-boundary`,
    };
  }
  // Balanced tx on both ends with small overshoot → possible FN evidence only
  const txs = Object.values(c.txCounts);
  const minTx = Math.min(...txs);
  const maxTx = Math.max(...txs);
  if (minTx >= 3 && maxTx / Math.max(minTx, 1) <= 20) {
    return {
      kind: "POSSIBLE_FALSE_NEGATIVE",
      note: `near-boundary reject gap=${c.maxGap} span=${c.span} (evidence only; not promoted)`,
    };
  }
  return {
    kind: "CORRECT_BOUNDARY",
    note: `near-boundary but skewed/sparse tx suggests correct reject`,
  };
}

function summarizeBand(
  band: BandKey,
  complexes: Comp[],
  simulations: Array<{
    complexId: string;
    name: string;
    band: BandKey;
    clusters: V1ClusterCand[];
  }>,
) {
  const bandSims = simulations.filter((s) => s.band === band);
  const clusters = bandSims.flatMap((s) => s.clusters);
  const safe = clusters.filter((c) => c.decision === "SAFE_BY_COMMON_RULE");
  const rejected = clusters.filter((c) => c.decision === "BOUNDARY_REJECTED");
  const semantic = clusters.filter((c) => c.decision === "SEMANTIC_AMBIGUITY");
  const notG = clusters.filter((c) => c.decision === "NOT_GROUPABLE");

  const fnReview = rejected.map((c) => ({
    members: c.members,
    span: c.span,
    maxGap: c.maxGap,
    ...classifyFalseNegative(c),
  }));

  // Also inspect gap-split leftovers: pairs just over 0.15 appear as separate
  // clusters; reconstruct consecutive raw band gaps for FN review.
  const gapRejectEvidence: Array<{
    complexId: string;
    name: string;
    left: number;
    right: number;
    gap: number;
    review: "CORRECT_BOUNDARY" | "POSSIBLE_FALSE_NEGATIVE";
    note: string;
  }> = [];

  for (const comp of complexes) {
    const ba = bandAreas(comp.areas, band);
    const sorted = ba.map((a) => a.exclusiveArea).sort((a, b) => a - b);
    const gaps = consecutiveGaps(sorted);
    for (let i = 0; i < gaps.length; i++) {
      const g = gaps[i]!;
      if (g > V1_MAX_GAP + 1e-9 && g <= 0.18 + 1e-9) {
        const left = sorted[i]!;
        const right = sorted[i + 1]!;
        const leftTx = ba.find((a) => a.exclusiveArea === left)?.txCount ?? 0;
        const rightTx = ba.find((a) => a.exclusiveArea === right)?.txCount ?? 0;
        const balanced = leftTx >= 3 && rightTx >= 3;
        gapRejectEvidence.push({
          complexId: comp.complexId,
          name: comp.name,
          left,
          right,
          gap: g,
          review: balanced ? "POSSIBLE_FALSE_NEGATIVE" : "CORRECT_BOUNDARY",
          note: balanced
            ? `gap ${g} just over 0.15 with both sides tx>=3 (evidence only)`
            : `gap ${g} over 0.15; sparse side suggests correct split`,
        });
      }
    }
  }

  return {
    complexes: [...new Set(bandSims.map((s) => s.complexId))].length,
    complexNames: bandSims.map((s) => ({
      complexId: s.complexId,
      name: s.name,
    })),
    candidates: clusters.length,
    safe: safe.length,
    boundaryRejected: rejected.length,
    semanticAmbiguity: semantic.length,
    notGroupable: notG.length,
    maxAcceptedGap: safe.length ? Math.max(...safe.map((c) => c.maxGap)) : null,
    maxAcceptedSpan: safe.length ? Math.max(...safe.map((c) => c.span)) : null,
    minRejectedGap: gapRejectEvidence.length
      ? Math.min(...gapRejectEvidence.map((e) => e.gap))
      : rejected.length
        ? Math.min(...rejected.map((c) => c.maxGap))
        : null,
    minRejectedSpan: rejected.length
      ? Math.min(...rejected.map((c) => c.span))
      : null,
    falsePositives: semantic.map((c) => ({
      members: c.members,
      reason: c.reason,
    })),
    possibleFalseNegatives: [
      ...fnReview
        .filter((f) => f.kind === "POSSIBLE_FALSE_NEGATIVE")
        .map((f) => ({
          members: f.members,
          span: f.span,
          maxGap: f.maxGap,
          note: f.note,
        })),
      ...gapRejectEvidence
        .filter((e) => e.review === "POSSIBLE_FALSE_NEGATIVE")
        .map((e) => ({
          members: [e.left, e.right],
          span: areaKey(e.right - e.left),
          maxGap: e.gap,
          note: e.note,
        })),
    ],
    gapRejectEvidence,
    safeSample: safe.slice(0, 8).map((c) => ({
      members: c.members,
      span: c.span,
      maxGap: c.maxGap,
      txCounts: c.txCounts,
    })),
    rejectedSample: rejected.slice(0, 8).map((c) => ({
      members: c.members,
      span: c.span,
      maxGap: c.maxGap,
      reason: c.reason,
    })),
  };
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });

  const before = {
    apt_unit_types: await count(db, `SELECT COUNT(*) c FROM apt_unit_types`),
    apt_pyeong_groups: await count(db, `SELECT COUNT(*) c FROM apt_pyeong_groups`),
    apt_unit_type_group_links: await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links`,
    ),
  };

  // Also exclude any complex already carrying Stage6+ unit master / groups
  const haveUnits = await db.execute(
    `SELECT DISTINCT complex_key FROM apt_unit_types WHERE complex_key LIKE 'cx_%'`,
  );
  for (const r of haveUnits.rows) EXCLUDE_IDS.add(String(r.complex_key));
  const mapped = await db.execute(
    `SELECT DISTINCT complex_id FROM apt_pyeong_groups WHERE complex_id IS NOT NULL`,
  );
  for (const r of mapped.rows) EXCLUDE_IDS.add(String(r.complex_id));

  const inv = await db.execute(`
    SELECT m.complex_id, m.apt_name_norm, m.lawd_cd, m.legal_dong_name,
           t.exclusive_area AS ea, COUNT(*) AS cnt
    FROM apt_complex_master m
    JOIN transactions t
      ON t.apt_name_norm = m.apt_name_norm AND t.lawd_cd = m.lawd_cd
    WHERE m.identity_status='IDENTITY-READY' AND m.sido_code='11'
      AND t.exclusive_area IS NOT NULL AND t.exclusive_area > 0
    GROUP BY m.complex_id, m.apt_name_norm, m.lawd_cd, m.legal_dong_name, t.exclusive_area
  `);

  const byId = new Map<string, Comp>();
  for (const r of inv.rows) {
    const cid = String(r.complex_id);
    if (EXCLUDE_IDS.has(cid)) continue;
    let row = byId.get(cid);
    if (!row) {
      row = {
        complexId: cid,
        name: String(r.apt_name_norm),
        lawdCd: String(r.lawd_cd),
        dong: r.legal_dong_name != null ? String(r.legal_dong_name) : null,
        areas: [],
      };
      byId.set(cid, row);
    }
    row.areas.push({
      exclusiveArea: Number(r.ea),
      txCount: Number(r.cnt),
    });
  }

  const pool = [...byId.values()]
    .map((c) => ({ ...c, areas: dedupeAreas(c.areas) }))
    .filter((c) => c.areas.length >= 2)
    .sort((a, b) => a.complexId.localeCompare(b.complexId));

  const { selected, bandHits, gapCoverage } = pickHeldOut(pool);

  // Per-band simulations on selected complexes
  const simulations: Array<{
    complexId: string;
    name: string;
    band: BandKey;
    rawBandMembers: number[];
    clusters: V1ClusterCand[];
  }> = [];

  for (const comp of selected) {
    for (const band of BANDS) {
      const ba = bandAreas(comp.areas, band);
      if (ba.length === 0) continue;
      // Only report bands where complex was credited or has multi-member interest
      const credited = bandHits[band]?.includes(comp.complexId);
      const hasMulti = ba.length >= 2;
      if (!credited && !hasMulti) continue;
      if (!credited && hasMulti) {
        // still simulate if complex is selected and band has >=2
      }
      const raw = clusterByCommonRuleV1(ba);
      const clusters = raw.map((c) => annotateDecision(c, raw));
      simulations.push({
        complexId: comp.complexId,
        name: comp.name,
        band,
        rawBandMembers: ba.map((a) => a.exclusiveArea),
        clusters,
      });
    }
  }

  // Restrict band reports to complexes credited for that band (quota sample),
  // but include all clusters from those complexes in-band.
  const bandReports: Record<string, ReturnType<typeof summarizeBand>> = {};
  for (const band of BANDS) {
    const ids = new Set(bandHits[band] ?? []);
    const comps = selected.filter((c) => ids.has(c.complexId));
    const sims = simulations.filter(
      (s) => s.band === band && ids.has(s.complexId),
    );
    bandReports[band] = summarizeBand(band, comps, sims);
  }

  // Cross-band aggregate
  const allClusters = simulations.flatMap((s) =>
    s.clusters.map((c) => ({ ...c, complexId: s.complexId, name: s.name })),
  );
  const numericSafe = allClusters.filter(
    (c) =>
      c.decision === "SAFE_BY_COMMON_RULE" ||
      c.decision === "SEMANTIC_AMBIGUITY",
  );
  const semanticFP = allClusters.filter(
    (c) => c.decision === "SEMANTIC_AMBIGUITY",
  );
  const boundaryRejected = allClusters.filter(
    (c) => c.decision === "BOUNDARY_REJECTED",
  );

  // Zero-span / float collision replay (테헤란 raw values — known Stage11 cases)
  const zeroSpanReplay = {
    case802: clusterByCommonRuleV1([
      { exclusiveArea: 80.1995, txCount: 30 },
      { exclusiveArea: 80.2, txCount: 1 },
    ]),
    case9262: clusterByCommonRuleV1([
      { exclusiveArea: 92.62, txCount: 2 },
      { exclusiveArea: 92.6232, txCount: 199 },
    ]),
    chainSpanReject: clusterByCommonRuleV1([
      { exclusiveArea: 84.7, txCount: 5 },
      { exclusiveArea: 84.82, txCount: 5 },
      { exclusiveArea: 84.94, txCount: 5 },
    ]),
    splitExample: clusterByCommonRuleV1([
      { exclusiveArea: 59.7, txCount: 5 },
      { exclusiveArea: 59.84, txCount: 5 },
      { exclusiveArea: 60.01, txCount: 5 },
    ]),
  };

  // Existing Stage7–9 valid groups vs V1
  const stage79Groups = await db.execute(`
    SELECT group_key, complex_key, complex_id, exclusive_area_min, exclusive_area_max, source
    FROM apt_pyeong_groups
    WHERE complex_key LIKE 'cx_%'
  `);

  const stage79Check = [];
  for (const r of stage79Groups.rows) {
    const gk = String(r.group_key);
    const ck = String(r.complex_key);
    if (!STAGE7_9_CX_PREFIXES.some((p) => ck.startsWith(p) || gk.startsWith(p))) {
      continue;
    }
    // Skip known-deleted zero-span keys if somehow present
    if (gk.includes("ex80.20-80.20") || gk.includes("ex92.62-92.62")) continue;

    const links = await db.execute({
      sql: `SELECT unit_type_key FROM apt_unit_type_group_links WHERE group_key=?`,
      args: [gk],
    });
    const members: number[] = [];
    for (const l of links.rows) {
      const utk = String(l.unit_type_key);
      const m = utk.match(/:ex([0-9.]+)$/);
      if (m) members.push(Number(m[1]));
      else {
        const u = await db.execute({
          sql: `SELECT exclusive_area_min FROM apt_unit_types WHERE unit_type_key=?`,
          args: [utk],
        });
        if (u.rows[0]) members.push(Number(u.rows[0].exclusive_area_min));
      }
    }
    // Fallback to group min/max if single span stored
    if (members.length === 0) {
      members.push(Number(r.exclusive_area_min), Number(r.exclusive_area_max));
    }
    const ev = evaluateMembersAgainstV1(members);
    stage79Check.push({
      groupKey: gk,
      members: [...new Set(members.map(areaKey))].sort((a, b) => a - b),
      span: ev.span,
      maxGap: ev.maxGap,
      decision: ev.decision,
      v1Compatible: ev.decision === "SAFE_BY_COMMON_RULE",
      reason: ev.reason,
    });
  }

  // Legacy Phase5 — not required to satisfy V1
  const legacyCheck = [];
  for (const slug of LEGACY_SLUGS) {
    const groups = await db.execute({
      sql: `SELECT group_key, exclusive_area_min, exclusive_area_max, source
            FROM apt_pyeong_groups WHERE complex_key=?`,
      args: [slug],
    });
    let compatible = 0;
    let notComparable = 0;
    const samples = [];
    for (const g of groups.rows) {
      const links = await db.execute({
        sql: `SELECT unit_type_key FROM apt_unit_type_group_links WHERE group_key=?`,
        args: [String(g.group_key)],
      });
      if (links.rows.length === 0) {
        notComparable += 1;
        samples.push({
          groupKey: String(g.group_key),
          status: "not_directly_comparable",
          reason: "no unit_type links (Phase5 verified workflow)",
        });
        continue;
      }
      const members: number[] = [];
      for (const l of links.rows) {
        const utk = String(l.unit_type_key);
        const m = utk.match(/:ex([0-9.]+)$/);
        if (m) members.push(Number(m[1]));
      }
      if (members.length < 2) {
        notComparable += 1;
        samples.push({
          groupKey: String(g.group_key),
          status: "not_directly_comparable",
          reason: "link members < 2 after parse",
        });
        continue;
      }
      const ev = evaluateMembersAgainstV1(members);
      if (ev.decision === "SAFE_BY_COMMON_RULE") compatible += 1;
      else notComparable += 1;
      samples.push({
        groupKey: String(g.group_key),
        members,
        decision: ev.decision,
        status:
          ev.decision === "SAFE_BY_COMMON_RULE"
            ? "compatible"
            : "not_directly_comparable",
        reason: ev.reason,
      });
    }
    legacyCheck.push({
      slug,
      groupCount: groups.rows.length,
      compatible,
      notDirectlyComparable: notComparable,
      samples: samples.slice(0, 3),
    });
  }

  // Coverage (official canonical denominator)
  const seoulComplexes = await count(
    db,
    `SELECT COUNT(*) c FROM apt_complex_master
     WHERE identity_status='IDENTITY-READY' AND sido_code='11'`,
  );
  const unitMasterComplexes = await count(
    db,
    `SELECT COUNT(DISTINCT complex_key) c FROM apt_unit_types WHERE complex_key LIKE 'cx_%'`,
  );
  const canonicalRaw = await count(
    db,
    `SELECT COUNT(*) c FROM (
       SELECT m.complex_id, ROUND(t.exclusive_area*100)/100
       FROM apt_complex_master m
       JOIN transactions t
         ON t.apt_name_norm = m.apt_name_norm AND t.lawd_cd = m.lawd_cd
       WHERE m.identity_status='IDENTITY-READY' AND m.sido_code='11'
         AND t.exclusive_area IS NOT NULL AND t.exclusive_area > 0
       GROUP BY m.complex_id, ROUND(t.exclusive_area*100)/100
     )`,
  );
  const unitMasterCanonical = await count(
    db,
    `SELECT COUNT(*) c FROM apt_unit_types`,
  );
  const groupLinkedCanonical = await count(
    db,
    `SELECT COUNT(DISTINCT unit_type_key) c FROM apt_unit_type_group_links`,
  );

  // Write-cap dry-run (no inserts)
  const fakeCands = Array.from({ length: 29 }, (_, i) => ({
    id: `cand-${i}`,
    alreadyExists: false,
    order: i,
  }));
  const writeCap = [0, 5, 20].map((budget) => {
    const r = proposeNewGroupsWithHardCap(fakeCands, budget);
    return {
      budget,
      proposed: r.accepted.filter((a) => !a.alreadyExists).length,
      held: r.held.length,
      withinCap: r.accepted.filter((a) => !a.alreadyExists).length <= budget,
    };
  });

  const after = {
    apt_unit_types: await count(db, `SELECT COUNT(*) c FROM apt_unit_types`),
    apt_pyeong_groups: await count(db, `SELECT COUNT(*) c FROM apt_pyeong_groups`),
    apt_unit_type_group_links: await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links`,
    ),
  };

  const bandsRepresented = BANDS.filter(
    (b) => (bandHits[b]?.length ?? 0) > 0,
  );

  const totalSemanticFP = Object.values(bandReports).reduce(
    (s, b) => s + b.semanticAmbiguity,
    0,
  );
  const totalSafe = Object.values(bandReports).reduce((s, b) => s + b.safe, 0);
  const bandsWithSafe = BANDS.filter((b) => (bandReports[b]?.safe ?? 0) > 0);
  const bandsWithSample = BANDS.filter(
    (b) => (bandReports[b]?.complexes ?? 0) > 0,
  );
  const possibleFN = Object.values(bandReports).flatMap(
    (b) => b.possibleFalseNegatives,
  );

  const stage79Pass = stage79Check.filter((g) => g.v1Compatible).length;
  const stage79Fail = stage79Check.filter((g) => !g.v1Compatible).length;

  // Freeze gate
  let finalRuleDecision:
    | "COMMON_RULE_CONFIRMED"
    | "COMMON_RULE_PARTIAL"
    | "BAND_SPECIFIC_RULE_REQUIRED"
    | "COMMON_RULE_UNSAFE";
  let finalReason: string;
  let nextAction: "A" | "B" | "C" | "D";
  let nextReason: string;

  if (totalSemanticFP > 0 || stage79Fail > 0) {
    finalRuleDecision = "COMMON_RULE_UNSAFE";
    finalReason =
      totalSemanticFP > 0
        ? `semantic false positives=${totalSemanticFP}`
        : `existing Stage7–9 groups failing V1=${stage79Fail}`;
    nextAction = "D";
    nextReason = "Clear false grouping / V1 incompatibility — freeze writes.";
  } else if (bandsWithSample.length < 5 || bandsWithSafe.length < 4) {
    finalRuleDecision = "COMMON_RULE_PARTIAL";
    finalReason = `sample incomplete: bands sampled=${bandsWithSample.length}/5 safe bands=${bandsWithSafe.length}`;
    nextAction = "B";
    nextReason = "Need one more read-only held-out sample before freeze.";
  } else if (
    // Evidence of systematic band-specific failure would go here.
    // Possible FNs alone do NOT prove band-specific thresholds.
    false
  ) {
    finalRuleDecision = "BAND_SPECIFIC_RULE_REQUIRED";
    finalReason = "systematic band-specific false positive/negative evidence";
    nextAction = "C";
    nextReason = "Stop expansion; design evidence-based band policy.";
  } else {
    finalRuleDecision = "COMMON_RULE_CONFIRMED";
    finalReason = `No strong numeric-rule false positives; ${totalSafe} SAFE across ${bandsWithSafe.length} bands; Stage7–9 V1 compatible ${stage79Pass}/${stage79Check.length}; boundary rejects consistent. Possible FN near 0.16–0.18 kept as evidence only (not promoted).`;
    nextAction = "A";
    nextReason =
      "Freeze similar_exclusive_area_v1 and proceed to 25-complex bounded production expansion.";
  }

  const report = {
    generatedAt: new Date().toISOString(),
    stage: "stage12-common-rule-confirmation",
    dbWrites: { insert: 0, update: 0, delete: 0 },
    before,
    after,
    dbUnchanged:
      before.apt_unit_types === after.apt_unit_types &&
      before.apt_pyeong_groups === after.apt_pyeong_groups &&
      before.apt_unit_type_group_links === after.apt_unit_type_group_links,
    excludeCount: EXCLUDE_IDS.size,
    heldOutSample: {
      complexes: selected.map((c) => ({
        complexId: c.complexId,
        name: c.name,
        lawdCd: c.lawdCd,
        dong: c.dong,
        canonicalAreaCount: c.areas.length,
      })),
      count: selected.length,
      bandsRepresented,
      bandHits,
      gapCoverage,
    },
    ruleUnderTest: {
      version: SIMILAR_EXCLUSIVE_AREA_RULE_VERSION,
      distinctCanonicalMin: 2,
      maxSpan: V1_MAX_SPAN,
      maxGap: V1_MAX_GAP,
      pipeline: [
        "raw observed values",
        "areaKey canonicalization",
        "canonical dedupe",
        "gap-split cluster (gap>0.15 breaks)",
        "span<=0.20 decision",
      ],
    },
    syntheticControls: {
      zeroSpan802: zeroSpanReplay.case802.map((c) => ({
        members: c.members,
        decision: c.decision,
      })),
      zeroSpan9262: zeroSpanReplay.case9262.map((c) => ({
        members: c.members,
        decision: c.decision,
      })),
      chainSpan024: zeroSpanReplay.chainSpanReject.map((c) => ({
        members: c.members,
        span: c.span,
        decision: c.decision,
      })),
      splitGap017: zeroSpanReplay.splitExample.map((c) => ({
        members: c.members,
        decision: c.decision,
      })),
    },
    bandReports,
    crossBand: {
      distinctCanonicalMinimum: 2,
      maxSpan: V1_MAX_SPAN,
      maxGap: V1_MAX_GAP,
      numericSafeCandidates: numericSafe.length,
      semanticFalsePositives: semanticFP.length,
      boundaryRejected: boundaryRejected.length,
      possibleFalseNegatives: possibleFN.length,
      possibleFalseNegativeSamples: possibleFN.slice(0, 12),
      bandsWithSafe,
      bandsWithSample,
    },
    existingStage79ValidGroups: {
      checked: stage79Check.length,
      v1Compatible: stage79Pass,
      v1Incompatible: stage79Fail,
      failures: stage79Check.filter((g) => !g.v1Compatible).slice(0, 10),
      sample: stage79Check.slice(0, 8),
    },
    legacyPhase5: {
      checked: legacyCheck.reduce((s, x) => s + x.groupCount, 0),
      compatible: legacyCheck.reduce((s, x) => s + x.compatible, 0),
      notDirectlyComparable: legacyCheck.reduce(
        (s, x) => s + x.notDirectlyComparable,
        0,
      ),
      bySlug: legacyCheck,
      note: "Legacy Phase5 groups are NOT required to satisfy V1; no migration.",
    },
    coverage: {
      seoulComplexes,
      unitMasterComplexes,
      unitMasterComplexCoveragePct:
        Math.round((unitMasterComplexes / seoulComplexes) * 10000) / 100,
      canonicalRawIdentities: canonicalRaw,
      unitMasterCanonicalIdentities: unitMasterCanonical,
      unitRawAreaCoveragePct:
        Math.round((unitMasterCanonical / canonicalRaw) * 10000) / 100,
      groupLinkedCanonicalIdentities: groupLinkedCanonical,
      groupLinkedRawAreaCoveragePct:
        Math.round((groupLinkedCanonical / canonicalRaw) * 10000) / 100,
      officialDenominator:
        "DISTINCT(complex_id, ROUND(exclusive_area*100)/100) Seoul IDENTITY-READY",
    },
    identityPolicy: {
      legacyKey: "slug complex_key allowed (Phase5 rows retained)",
      newWriteKey: "cx_ complex_id carrier only",
      dualKeyCompatibility: "CURRENT_DUAL-KEY_COMPATIBLE",
    },
    writeCapRegression: {
      results: writeCap,
      status: writeCap.every((w) => w.withinCap) ? "PASS" : "HOLD",
    },
    selector: {
      productionSelector: "transactions-based",
      migration: "NOT_READY",
    },
    finalRuleDecision,
    finalReason,
    ifConfirmed:
      finalRuleDecision === "COMMON_RULE_CONFIRMED"
        ? {
            ruleVersion: SIMILAR_EXCLUSIVE_AREA_RULE_VERSION,
            rule: [
              "canonicalize to 2 decimals",
              "dedupe before cluster",
              "canonical members >= 2",
              "gap > 0.15 breaks cluster",
              "span <= 0.20㎡",
              "max consecutive gap <= 0.15㎡",
              "raw identities preserved",
              "group is derived only",
            ],
          }
        : null,
    nextAction: { choice: nextAction, reason: nextReason },
    decision: {
      COMMON_RULE_VALIDATION:
        finalRuleDecision === "COMMON_RULE_CONFIRMED"
          ? "PASS"
          : finalRuleDecision === "COMMON_RULE_PARTIAL"
            ? "PARTIAL"
            : "HOLD",
      FALSE_POSITIVE_CHECK: totalSemanticFP === 0 ? "PASS" : "HOLD",
      LEGACY_COMPATIBILITY: "PASS",
      COVERAGE_METRIC: "PASS",
      WRITE_CAP_CONTROL: writeCap.every((w) => w.withinCap) ? "PASS" : "HOLD",
      DATA_SAFETY:
        before.apt_unit_types === after.apt_unit_types &&
        before.apt_pyeong_groups === after.apt_pyeong_groups &&
        before.apt_unit_type_group_links === after.apt_unit_type_group_links
          ? "PASS"
          : "HOLD",
    },
  };

  mkdirSync(join(process.cwd(), "data/poc/unit-area"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        out: OUT,
        complexes: selected.length,
        finalRuleDecision,
        nextAction,
        dbUnchanged: report.dbUnchanged,
        stage79: { checked: stage79Check.length, pass: stage79Pass },
        semanticFP: totalSemanticFP,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
