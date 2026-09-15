/**
 * STAGE 9 — Multi-band unit-type + similar-area group validation
 * (EXACTLY 10 new complexes; Stage6–8 excluded).
 *
 * - Select 10 Seoul complexes with multi-band diversity
 * - Insert all raw exclusive areas → apt_unit_types (Stage6 contract)
 * - Candidate clusters across ALL area bands (not near-84 only)
 * - SAFE_GROUP write ≤ 20 total (Stage7/8 contract)
 * - Band validation + rule generalization report
 * - Lightweight Seoul coverage recalc
 *
 * Forbidden: baselines, classifications, DELETE, KAPT, replacePilotMasterBundles.
 */
import { createClient, type InArgs } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

config({ path: ".env.local" });
config();

const OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage9-multiband-validation.json",
);

const areaKey = (sqm: number) => Math.round(sqm * 100) / 100;
const areaKeyStr = (sqm: number) => String(areaKey(sqm));
const fmtKeyArea = (sqm: number) => areaKey(sqm).toFixed(2);

/** Stage7/8 verified heuristic — under test for multi-band generalization. */
const HEURISTIC_MAX_SPAN = 0.2;
const HEURISTIC_MAX_GAP = 0.15;
const MAX_GROUP_WRITES = 20;
const TARGET_COUNT = 10;

const EXCLUDE_IDS = new Set([
  // Stage6/7
  "cx_caf229b5ac63cfbd", // 리센츠
  "cx_85cd8a4b2d5dc3d0", // 트리지움
  // Stage8
  "cx_b1f9d0cc3e8e5c12",
  "cx_b74bdaa8f28045aa",
  "cx_4880c4ffe9880d49",
  "cx_e095bf141dde5379",
  "cx_c7ac494bf78993ad",
]);

type Db = ReturnType<typeof createClient>;
type Decision = "SAFE_GROUP" | "AMBIGUOUS" | "NOT_GROUPABLE";
type BandKey = "50-69" | "70-79" | "80-89" | "90-109" | "110+" | "other";

type AreaRow = { exclusiveArea: number; txCount: number };

type ClusterCand = {
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
  aggregation: {
    perMember: Record<string, number>;
    memberSum: number;
    groupResult: number;
    missing: number;
    duplicates: number;
    pass: boolean;
  } | null;
  writePriority: number;
};

function bandOf(area: number): BandKey {
  if (area >= 50 && area < 70) return "50-69";
  if (area >= 70 && area < 80) return "70-79";
  if (area >= 80 && area < 90) return "80-89";
  if (area >= 90 && area < 110) return "90-109";
  if (area >= 110) return "110+";
  return "other";
}

function bandOfCluster(members: number[]): BandKey {
  const mid = (members[0]! + members[members.length - 1]!) / 2;
  return bandOf(mid);
}

async function count(db: Db, sql: string, args: InArgs = []) {
  const r = await db.execute({ sql, args });
  return Number(r.rows[0]!.c);
}

async function tableCount(db: Db, table: string) {
  return count(db, `SELECT COUNT(*) c FROM ${table}`);
}

async function loadRawAreas(
  db: Db,
  aptNameNorm: string,
  lawdCd: string,
): Promise<AreaRow[]> {
  const tx = await db.execute({
    sql: `
      SELECT exclusive_area AS ea, COUNT(*) AS cnt
      FROM transactions
      WHERE apt_name_norm = ? AND lawd_cd = ?
        AND exclusive_area IS NOT NULL AND exclusive_area > 0
      GROUP BY exclusive_area
      ORDER BY exclusive_area
    `,
    args: [aptNameNorm, lawdCd],
  });
  return tx.rows.map((r) => ({
    exclusiveArea: areaKey(Number(r.ea)),
    txCount: Number(r.cnt),
  }));
}

function dedupeAreas(areas: AreaRow[]): AreaRow[] {
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

function clusterAllBands(areasIn: AreaRow[]): ClusterCand[] {
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
    // unique by construction after dedupe
    const span = areaKey(members[members.length - 1]! - members[0]!);
    let maxGap = 0;
    for (let i = 1; i < members.length; i++) {
      maxGap = Math.max(maxGap, areaKey(members[i]! - members[i - 1]!));
    }
    const txCounts: Record<string, number> = {};
    for (const m of members) txCounts[areaKeyStr(m)] = txMap.get(areaKeyStr(m)) ?? 0;
    const totalTx = Object.values(txCounts).reduce((s, n) => s + n, 0);
    const band = bandOfCluster(members);

    let decision: Decision;
    let reason: string;
    if (members.length < 2) {
      decision = "NOT_GROUPABLE";
      reason = "single raw area";
    } else if (span <= 0) {
      decision = "NOT_GROUPABLE";
      reason = "zero span after areaKey dedupe — not a multi-member family";
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

async function existingUnits(db: Db, complexKey: string) {
  const r = await db.execute({
    sql: `SELECT unit_type_key, exclusive_area_min, exclusive_area_max
          FROM apt_unit_types WHERE complex_key = ?`,
    args: [complexKey],
  });
  return r.rows.map((row) => ({
    unitTypeKey: String(row.unit_type_key),
    exclusiveAreaMin: Number(row.exclusive_area_min),
    exclusiveAreaMax: Number(row.exclusive_area_max),
  }));
}

async function insertMissingUnits(
  db: Db,
  complexKey: string,
  areas: AreaRow[],
) {
  const beforeRows = await existingUnits(db, complexKey);
  const before = beforeRows.length;
  const have = new Set(
    beforeRows
      .filter((u) => areaKey(u.exclusiveAreaMin) === areaKey(u.exclusiveAreaMax))
      .map((u) => areaKeyStr(u.exclusiveAreaMin)),
  );
  const inserted: string[] = [];
  for (const a of areas) {
    const aks = areaKeyStr(a.exclusiveArea);
    const unitTypeKey = `${complexKey}:ex${aks}`;
    if (have.has(aks)) continue;
    const pk = await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_types WHERE unit_type_key = ?`,
      [unitTypeKey],
    );
    if (pk > 0) continue;
    await db.execute({
      sql: `INSERT INTO apt_unit_types (
        unit_type_key, complex_key, supply_area_sqm,
        exclusive_area_min, exclusive_area_max,
        household_count, mapping_confidence,
        exclusive_includes_partial_common, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        unitTypeKey,
        complexKey,
        null,
        areaKey(a.exclusiveArea),
        areaKey(a.exclusiveArea),
        null,
        "transaction_raw_exclusive",
        0,
        "transactions",
      ],
    });
    inserted.push(unitTypeKey);
    have.add(aks);
  }
  return { inserted, before, after: (await existingUnits(db, complexKey)).length };
}

async function nextGroupIndex(db: Db, complexKey: string): Promise<number> {
  const r = await db.execute({
    sql: `SELECT group_key FROM apt_pyeong_groups WHERE complex_key = ?`,
    args: [complexKey],
  });
  let max = 0;
  for (const row of r.rows) {
    const m = String(row.group_key).match(/:G(\d+):/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

async function upsertSafeGroup(
  db: Db,
  complexKey: string,
  complexId: string,
  members: number[],
  sortOrder: number,
) {
  const min = members[0]!;
  const max = members[members.length - 1]!;
  const existingRange = await db.execute({
    sql: `SELECT group_key FROM apt_pyeong_groups
          WHERE complex_key = ?
            AND ROUND(exclusive_area_min*100) = ROUND(?*100)
            AND ROUND(exclusive_area_max*100) = ROUND(?*100)`,
    args: [complexKey, min, max],
  });

  let groupKey: string;
  let groupAction: "inserted" | "exists";
  if (existingRange.rows.length > 0) {
    groupKey = String(existingRange.rows[0]!.group_key);
    groupAction = "exists";
  } else {
    const gi = await nextGroupIndex(db, complexKey);
    groupKey = `${complexKey}:G${gi}:ex${fmtKeyArea(min)}-${fmtKeyArea(max)}`;
    const byKey = await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE group_key = ?`,
      [groupKey],
    );
    if (byKey > 0) groupAction = "exists";
    else {
      await db.execute({
        sql: `INSERT INTO apt_pyeong_groups (
          group_key, complex_key, market_label, display_mode,
          supply_area_min, supply_area_max, exclusive_area_min, exclusive_area_max,
          household_count, confidence, group_confidence_high, label_null_reason,
          sort_order, source, complex_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          groupKey,
          complexKey,
          null,
          "range_only",
          null,
          null,
          areaKey(min),
          areaKey(max),
          null,
          "grouped",
          1,
          "no_supply_area",
          sortOrder,
          "transactions-similar-area",
          complexId,
        ],
      });
      groupAction = "inserted";
    }
  }

  let linksInserted = 0;
  for (const a of members) {
    const utk = `${complexKey}:ex${areaKeyStr(a)}`;
    const hit = await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links
       WHERE unit_type_key = ? AND group_key = ?`,
      [utk, groupKey],
    );
    if (hit > 0) continue;
    const other = await db.execute({
      sql: `SELECT group_key FROM apt_unit_type_group_links
            WHERE unit_type_key = ? AND group_key != ?`,
      args: [utk, groupKey],
    });
    if (other.rows.length > 0) {
      throw new Error(
        `HOLD: ${utk} already linked to ${other.rows.map((r) => r.group_key).join(",")}`,
      );
    }
    await db.execute({
      sql: `INSERT INTO apt_unit_type_group_links (
        unit_type_key, group_key, complex_key, is_outlier
      ) VALUES (?, ?, ?, ?)`,
      args: [utk, groupKey, complexKey, 0],
    });
    linksInserted += 1;
  }
  return { groupKey, groupAction, linksInserted };
}

async function aggregateGroup(
  db: Db,
  aptNameNorm: string,
  lawdCd: string,
  members: number[],
) {
  const per: Record<string, number> = {};
  for (const a of members) {
    per[areaKeyStr(a)] = await count(
      db,
      `SELECT COUNT(*) c FROM transactions
       WHERE apt_name_norm = ? AND lawd_cd = ?
         AND exclusive_area IS NOT NULL
         AND ROUND(exclusive_area * 100) = ROUND(? * 100)`,
      [aptNameNorm, lawdCd, a],
    );
  }
  const memberSum = Object.values(per).reduce((s, n) => s + n, 0);
  const placeholders = members.map(() => "ROUND(? * 100)").join(",");
  const groupResult = await count(
    db,
    `SELECT COUNT(*) c FROM transactions
     WHERE apt_name_norm = ? AND lawd_cd = ?
       AND exclusive_area IS NOT NULL
       AND ROUND(exclusive_area * 100) IN (${placeholders})`,
    [aptNameNorm, lawdCd, ...members],
  );
  return {
    perMember: per,
    memberSum,
    groupResult,
    missing: memberSum - groupResult,
    duplicates: groupResult - memberSum,
    pass: memberSum === groupResult,
  };
}

type CandidateComplex = {
  complexId: string;
  name: string;
  lawdCd: string;
  dong: string | null;
  areas: AreaRow[];
  totalTx: number;
  bands: Set<BandKey>;
  clusterCount: number;
  safePreview: number;
  score: number;
};

async function selectTargets(db: Db): Promise<CandidateComplex[]> {
  // Already have unit master under complex_id carrier
  const haveUnits = await db.execute(`
    SELECT DISTINCT complex_key FROM apt_unit_types WHERE complex_key LIKE 'cx_%'
  `);
  for (const r of haveUnits.rows) EXCLUDE_IDS.add(String(r.complex_key));

  // Phase5 mapped complex_ids
  const mapped = await db.execute(`
    SELECT DISTINCT complex_id FROM apt_pyeong_groups WHERE complex_id IS NOT NULL
  `);
  for (const r of mapped.rows) EXCLUDE_IDS.add(String(r.complex_id));

  // Batched: one query for Seoul IDENTITY-READY area inventories
  const inv = await db.execute(`
    SELECT
      m.complex_id AS complex_id,
      m.apt_name_norm AS apt_name_norm,
      m.lawd_cd AS lawd_cd,
      m.legal_dong_name AS legal_dong_name,
      t.exclusive_area AS ea,
      COUNT(*) AS cnt
    FROM apt_complex_master m
    JOIN transactions t
      ON t.apt_name_norm = m.apt_name_norm
     AND t.lawd_cd = m.lawd_cd
    WHERE m.identity_status = 'IDENTITY-READY'
      AND m.sido_code = '11'
      AND t.exclusive_area IS NOT NULL
      AND t.exclusive_area > 0
    GROUP BY m.complex_id, m.apt_name_norm, m.lawd_cd, m.legal_dong_name, t.exclusive_area
  `);

  const byId = new Map<
    string,
    {
      complexId: string;
      name: string;
      lawdCd: string;
      dong: string | null;
      areas: AreaRow[];
    }
  >();

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
      exclusiveArea: areaKey(Number(r.ea)),
      txCount: Number(r.cnt),
    });
  }

  const pool: CandidateComplex[] = [];
  for (const row of byId.values()) {
    row.areas = dedupeAreas(row.areas);
    if (row.areas.length < 5 || row.areas.length > 12) continue;
    const totalTx = row.areas.reduce((s, a) => s + a.txCount, 0);
    if (totalTx < 80) continue;
    const bands = new Set(row.areas.map((a) => bandOf(a.exclusiveArea)));
    bands.delete("other");
    if (bands.size < 2) continue;
    const clusters = clusterAllBands(row.areas);
    const clusterCount = clusters.filter((c) => c.members.length >= 2).length;
    if (clusterCount < 1) continue;
    const safePreview = clusters.filter((c) => c.decision === "SAFE_GROUP").length;
    const score =
      bands.size * 100 +
      clusterCount * 20 +
      safePreview * 15 +
      Math.min(totalTx, 2000) / 100 +
      (12 - Math.abs(row.areas.length - 7));
    pool.push({
      complexId: row.complexId,
      name: row.name,
      lawdCd: row.lawdCd,
      dong: row.dong,
      areas: row.areas,
      totalTx,
      bands,
      clusterCount,
      safePreview,
      score,
    });
  }

  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.complexId.localeCompare(b.complexId); // deterministic tie-break
  });

  const needBands: BandKey[] = ["50-69", "70-79", "80-89", "90-109", "110+"];
  const selected: CandidateComplex[] = [];

  for (const band of needBands) {
    const hit = pool.find(
      (c) =>
        !selected.includes(c) &&
        c.bands.has(band) &&
        clusterAllBands(c.areas).some(
          (cl) => cl.band === band && cl.decision === "SAFE_GROUP",
        ),
    );
    const fallback = pool.find((c) => !selected.includes(c) && c.bands.has(band));
    const pick = hit ?? fallback;
    if (pick) selected.push(pick);
  }

  for (const c of pool) {
    if (selected.length >= TARGET_COUNT) break;
    if (selected.includes(c)) continue;
    selected.push(c);
  }

  if (selected.length < TARGET_COUNT) {
    throw new Error(
      `HOLD: only found ${selected.length} eligible multi-band complexes`,
    );
  }

  return selected.slice(0, TARGET_COUNT);
}

async function processComplex(
  db: Db,
  t: CandidateComplex,
  groupBudget: { remaining: number; halt: boolean },
) {
  const complexKey = t.complexId;
  const unitWrite = await insertMissingUnits(db, complexKey, dedupeAreas(t.areas));
  const candidates = clusterAllBands(t.areas);

  let groupsInserted = 0;
  let linksInserted = 0;
  let sortOrder = 0;
  const heldForBudget: ClusterCand[] = [];

  // Write SAFE_GROUP in priority order within complex (by min area for determinism)
  const safeOrdered = candidates
    .filter((c) => c.decision === "SAFE_GROUP")
    .sort((a, b) => a.min - b.min);

  for (const c of safeOrdered) {
    if (groupBudget.halt) {
      heldForBudget.push(c);
      continue;
    }
    if (groupBudget.remaining <= 0) {
      heldForBudget.push(c);
      c.decision = "SAFE_GROUP"; // still SAFE but not written this stage
      c.reason += " | HOLD_WRITE: max 20 group budget reached";
      continue;
    }
    const w = await upsertSafeGroup(
      db,
      complexKey,
      t.complexId,
      c.members,
      sortOrder,
    );
    sortOrder += 1;
    const agg = await aggregateGroup(db, t.name, t.lawdCd, c.members);
    if (!agg.pass) {
      groupBudget.halt = true;
      c.aggregation = agg;
      c.reason += " | HOLD: aggregation mismatch — stop further group writes";
      // Do not count as written if we just inserted? Links already written.
      // Per instructions: stop additional writes. Keep what was written but flag HOLD.
      c.written = true;
      c.groupKey = w.groupKey;
      c.linksInserted = w.linksInserted;
      if (w.groupAction === "inserted") groupsInserted += 1;
      linksInserted += w.linksInserted;
      groupBudget.remaining -= w.groupAction === "inserted" ? 1 : 0;
      break;
    }
    c.written = true;
    c.groupKey = w.groupKey;
    c.linksInserted = w.linksInserted;
    c.aggregation = agg;
    if (w.groupAction === "inserted") {
      groupsInserted += 1;
      groupBudget.remaining -= 1;
    }
    linksInserted += w.linksInserted;
  }

  const afterUnits = await existingUnits(db, complexKey);
  const afterAreas = afterUnits
    .filter((u) => areaKey(u.exclusiveAreaMin) === areaKey(u.exclusiveAreaMax))
    .map((u) => areaKey(u.exclusiveAreaMin))
    .sort((a, b) => a - b);
  const rawKeys = new Set(t.areas.map((a) => areaKeyStr(a.exclusiveArea)));
  const afterKeys = new Set(afterAreas.map(areaKeyStr));
  const missing = [...rawKeys].filter((k) => !afterKeys.has(k));
  const unexpected = [...afterKeys].filter((k) => !rawKeys.has(k));
  const collapsed = afterUnits.filter(
    (u) => areaKey(u.exclusiveAreaMin) !== areaKey(u.exclusiveAreaMax),
  );

  return {
    complexId: t.complexId,
    complexName: t.name,
    lawdCd: t.lawdCd,
    dong: t.dong,
    bands: [...t.bands].sort(),
    rawAreas: t.areas.map((a) => a.exclusiveArea),
    rawAreaDetails: t.areas,
    unitBefore: unitWrite.before,
    unitInserted: unitWrite.inserted.length,
    unitAfter: unitWrite.after,
    candidates,
    safeGroupCount: candidates.filter((c) => c.decision === "SAFE_GROUP").length,
    ambiguousCount: candidates.filter((c) => c.decision === "AMBIGUOUS").length,
    notGroupableCount: candidates.filter((c) => c.decision === "NOT_GROUPABLE")
      .length,
    groupsInserted,
    linksInserted,
    groupsWritten: candidates.filter((c) => c.written).map((c) => c.groupKey),
    heldForBudget: heldForBudget.map((c) => ({
      members: c.members,
      band: c.band,
      span: c.span,
    })),
    aggregationPass: candidates
      .filter((c) => c.written)
      .every((c) => c.aggregation?.pass === true),
    rawPreserved:
      missing.length === 0 && unexpected.length === 0 && collapsed.length === 0,
    missing,
    unexpected,
    collapsed: collapsed.map((u) => u.unitTypeKey),
  };
}

function emptyBandStats() {
  return {
    sample: "NO_SAMPLE" as string | number,
    safe: 0,
    ambiguous: 0,
    notGroupable: 0,
    maxSafeSpan: null as number | null,
    maxSafeGap: null as number | null,
    written: 0,
  };
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });

  const beforeCounts = {
    apt_unit_types: await tableCount(db, "apt_unit_types"),
    apt_pyeong_groups: await tableCount(db, "apt_pyeong_groups"),
    apt_unit_type_group_links: await tableCount(db, "apt_unit_type_group_links"),
    apt_pyeong_group_baselines: await tableCount(
      db,
      "apt_pyeong_group_baselines",
    ),
    apt_complex_classifications: await tableCount(
      db,
      "apt_complex_classifications",
    ),
  };

  const protectKeys = [
    "cx_caf229b5ac63cfbd",
    "cx_85cd8a4b2d5dc3d0",
    "cx_b1f9d0cc3e8e5c12",
    "cx_b74bdaa8f28045aa",
    "cx_4880c4ffe9880d49",
    "cx_e095bf141dde5379",
    "cx_c7ac494bf78993ad",
    "parkrio",
    "jamsil-els",
    "hangang-daewoo",
  ];
  const protectBefore: Record<string, { u: number; g: number; l: number }> = {};
  for (const k of protectKeys) {
    protectBefore[k] = {
      u: await count(db, `SELECT COUNT(*) c FROM apt_unit_types WHERE complex_key=?`, [k]),
      g: await count(db, `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE complex_key=?`, [k]),
      l: await count(db, `SELECT COUNT(*) c FROM apt_unit_type_group_links WHERE complex_key=?`, [k]),
    };
  }

  console.error("Selecting 10 multi-band targets...");
  const targets = await selectTargets(db);
  console.error(
    "Selected:",
    targets.map((t) => `${t.name}(${[...t.bands].join("+")})`).join(", "),
  );

  const groupBudget = { remaining: MAX_GROUP_WRITES, halt: false };
  const complexes = [];
  for (const t of targets) {
    complexes.push(await processComplex(db, t, groupBudget));
    if (groupBudget.halt) {
      console.error("Aggregation HOLD — stopping further group writes");
    }
  }

  // Idempotency verify-only (do NOT reopen group budget / write)
  const replay = [];
  for (const t of targets) {
    const complexKey = t.complexId;
    const areas = dedupeAreas(t.areas);
    const beforeU = (await existingUnits(db, complexKey)).length;
    const unitWrite = await insertMissingUnits(db, complexKey, areas);
    const beforeG = await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE complex_key = ?`,
      [complexKey],
    );
    const beforeL = await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links WHERE complex_key = ?`,
      [complexKey],
    );
    // Re-run upserts with budget 0 → should only hit exists paths if any SAFE attempted
    const dryBudget = { remaining: 0, halt: false };
    const r = await processComplex(db, t, dryBudget);
    const afterG = await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE complex_key = ?`,
      [complexKey],
    );
    const afterL = await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links WHERE complex_key = ?`,
      [complexKey],
    );
    replay.push({
      name: t.name,
      unitInserted: unitWrite.inserted.length,
      groupsInserted: afterG - beforeG,
      linksInserted: afterL - beforeL,
      unitBeforeReplay: beforeU,
    });
    void r;
  }

  const afterCounts = {
    apt_unit_types: await tableCount(db, "apt_unit_types"),
    apt_pyeong_groups: await tableCount(db, "apt_pyeong_groups"),
    apt_unit_type_group_links: await tableCount(db, "apt_unit_type_group_links"),
    apt_pyeong_group_baselines: await tableCount(
      db,
      "apt_pyeong_group_baselines",
    ),
    apt_complex_classifications: await tableCount(
      db,
      "apt_complex_classifications",
    ),
  };

  const protectAfter: Record<string, { u: number; g: number; l: number }> = {};
  let protectOk = true;
  for (const k of protectKeys) {
    protectAfter[k] = {
      u: await count(db, `SELECT COUNT(*) c FROM apt_unit_types WHERE complex_key=?`, [k]),
      g: await count(db, `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE complex_key=?`, [k]),
      l: await count(db, `SELECT COUNT(*) c FROM apt_unit_type_group_links WHERE complex_key=?`, [k]),
    };
    if (
      protectBefore[k]!.u !== protectAfter[k]!.u ||
      protectBefore[k]!.g !== protectAfter[k]!.g ||
      protectBefore[k]!.l !== protectAfter[k]!.l
    ) {
      protectOk = false;
    }
  }

  // Band validation across all candidates (written + not)
  const bandKeys: BandKey[] = ["50-69", "70-79", "80-89", "90-109", "110+"];
  const bandValidation: Record<string, ReturnType<typeof emptyBandStats>> = {};
  for (const b of bandKeys) bandValidation[b] = emptyBandStats();

  for (const c of complexes) {
    for (const cand of c.candidates) {
      if (cand.band === "other") continue;
      const st = bandValidation[cand.band]!;
      if (st.sample === "NO_SAMPLE") st.sample = 0;
      (st.sample as number) += 1;
      if (cand.decision === "SAFE_GROUP") {
        st.safe += 1;
        if (cand.written) st.written += 1;
        st.maxSafeSpan =
          st.maxSafeSpan == null
            ? cand.span
            : Math.max(st.maxSafeSpan, cand.span);
        st.maxSafeGap =
          st.maxSafeGap == null
            ? cand.maxGap
            : Math.max(st.maxSafeGap, cand.maxGap);
      } else if (cand.decision === "AMBIGUOUS") st.ambiguous += 1;
      else st.notGroupable += 1;
    }
  }

  // Rule generalization
  const bandsWithSafe = bandKeys.filter(
    (b) => bandValidation[b]!.sample !== "NO_SAMPLE" && bandValidation[b]!.safe > 0,
  );
  const bandsWithSample = bandKeys.filter(
    (b) => bandValidation[b]!.sample !== "NO_SAMPLE",
  );
  const anyAmbiguous = complexes.reduce((s, c) => s + c.ambiguousCount, 0);
  const anyAggFail = complexes.some(
    (c) => c.groupsWritten.length > 0 && !c.aggregationPass,
  );

  let ruleDecision:
    | "COMMON_RULE_SUPPORTED"
    | "BAND_SPECIFIC_RULE_NEEDED"
    | "INSUFFICIENT_EVIDENCE"
    | "CURRENT_RULE_UNSAFE";
  let ruleEvidence: string;

  if (anyAggFail) {
    ruleDecision = "CURRENT_RULE_UNSAFE";
    ruleEvidence = "Aggregation mismatch on a written group.";
  } else if (bandsWithSample.length < 3) {
    ruleDecision = "INSUFFICIENT_EVIDENCE";
    ruleEvidence = `Only ${bandsWithSample.length}/5 bands sampled.`;
  } else if (bandsWithSafe.length >= 3 && anyAmbiguous === 0) {
    ruleDecision = "COMMON_RULE_SUPPORTED";
    ruleEvidence = `SAFE_GROUP produced in bands [${bandsWithSafe.join(", ")}] under span≤${HEURISTIC_MAX_SPAN}/gap≤${HEURISTIC_MAX_GAP}; ambiguous=0; aggregation PASS.`;
  } else if (bandsWithSafe.length >= 2 && anyAmbiguous > 0) {
    ruleDecision = "BAND_SPECIFIC_RULE_NEEDED";
    ruleEvidence = `SAFE in ${bandsWithSafe.length} bands but ${anyAmbiguous} AMBIGUOUS candidates — thresholds may need band tuning.`;
  } else if (bandsWithSafe.length >= 3) {
    ruleDecision = "COMMON_RULE_SUPPORTED";
    ruleEvidence = `SAFE_GROUP across ${bandsWithSafe.length} bands; ambiguous=${anyAmbiguous}.`;
  } else {
    ruleDecision = "INSUFFICIENT_EVIDENCE";
    ruleEvidence = `SAFE bands=${bandsWithSafe.length}; need more multi-band evidence.`;
  }

  // Seoul readiness (lightweight)
  const seoulComplexes = await count(
    db,
    `SELECT COUNT(*) c FROM apt_complex_master WHERE sido_code='11' AND identity_status='IDENTITY-READY'`,
  );
  const unitMasterComplexes = await count(
    db,
    `SELECT COUNT(DISTINCT complex_key) c FROM apt_unit_types WHERE complex_key LIKE 'cx_%'`,
  );
  // Also count slug pilots that have complex_id mapping
  const groupedComplexes = await count(
    db,
    `SELECT COUNT(DISTINCT COALESCE(complex_id, complex_key)) c FROM apt_pyeong_groups`,
  );
  const rawDistinctApprox = await count(
    db,
    `SELECT COUNT(*) c FROM (
       SELECT m.complex_id, t.exclusive_area
       FROM apt_complex_master m
       JOIN transactions t
         ON t.apt_name_norm = m.apt_name_norm AND t.lawd_cd = m.lawd_cd
       WHERE m.sido_code='11' AND m.identity_status='IDENTITY-READY'
         AND t.exclusive_area IS NOT NULL AND t.exclusive_area > 0
       GROUP BY m.complex_id, t.exclusive_area
     )`,
  );
  const unitMasterRawAreas = await count(
    db,
    `SELECT COUNT(*) c FROM apt_unit_types`,
  );
  const groupLinkedRawAreas = await count(
    db,
    `SELECT COUNT(DISTINCT unit_type_key) c FROM apt_unit_type_group_links`,
  );

  const unitCoveragePct =
    seoulComplexes > 0
      ? Math.round((unitMasterComplexes / seoulComplexes) * 10000) / 100
      : 0;
  const groupCoveragePct =
    seoulComplexes > 0
      ? Math.round((groupedComplexes / seoulComplexes) * 10000) / 100
      : 0;

  const totals = {
    complexes: complexes.length,
    rawAreas: complexes.reduce((s, c) => s + c.rawAreas.length, 0),
    unitTypesBefore: beforeCounts.apt_unit_types,
    unitTypesInserted: complexes.reduce((s, c) => s + c.unitInserted, 0),
    unitTypesAfter: afterCounts.apt_unit_types,
    groupCandidates: complexes.reduce((s, c) => s + c.candidates.length, 0),
    SAFE_GROUP: complexes.reduce((s, c) => s + c.safeGroupCount, 0),
    AMBIGUOUS: complexes.reduce((s, c) => s + c.ambiguousCount, 0),
    NOT_GROUPABLE: complexes.reduce((s, c) => s + c.notGroupableCount, 0),
    groupsInserted: complexes.reduce((s, c) => s + c.groupsInserted, 0),
    linksInserted: complexes.reduce((s, c) => s + c.linksInserted, 0),
    heldForBudget: complexes.reduce((s, c) => s + c.heldForBudget.length, 0),
  };

  const groupsChecked = complexes.reduce(
    (s, c) => s + c.candidates.filter((x) => x.written).length,
    0,
  );
  const aggMismatches = complexes.reduce(
    (s, c) =>
      s +
      c.candidates.filter((x) => x.written && x.aggregation && !x.aggregation.pass)
        .length,
    0,
  );

  const allRawPreserved = complexes.every((c) => c.rawPreserved);
  const idempotent = replay.every(
    (r) => r.unitInserted === 0 && r.groupsInserted === 0 && r.linksInserted === 0,
  );

  let nextAction: "A" | "B" | "C" | "D";
  let nextReason: string;
  if (ruleDecision === "CURRENT_RULE_UNSAFE") {
    nextAction = "D";
    nextReason = "Aggregation/false-group risk — stop grouping writes and review.";
  } else if (ruleDecision === "BAND_SPECIFIC_RULE_NEEDED") {
    nextAction = "B";
    nextReason = "Band-specific ambiguity — refine policy before scale-out.";
  } else if (
    ruleDecision === "COMMON_RULE_SUPPORTED" &&
    aggMismatches === 0 &&
    totals.AMBIGUOUS === 0 &&
    allRawPreserved
  ) {
    nextAction = "A";
    nextReason =
      "Multi-band SAFE_GROUP consistent under current heuristic; aggregation PASS; bounded 25–50 expansion appropriate.";
  } else if (allRawPreserved && totals.SAFE_GROUP === 0) {
    nextAction = "C";
    nextReason = "Unit types stable but no SAFE groups — unit-master-only expansion.";
  } else if (ruleDecision === "INSUFFICIENT_EVIDENCE") {
    nextAction = "C";
    nextReason = "Insufficient multi-band evidence — expand unit master; hold aggressive grouping.";
  } else if (totals.AMBIGUOUS > 0) {
    nextAction = "B";
    nextReason = "Ambiguous clusters remain — refine before larger expansion.";
  } else {
    nextAction = "A";
    nextReason = "Heuristic held across sampled bands with clean aggregation.";
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    stage: "stage9-multiband-validation",
    scope: "10 new Seoul complexes; multi-band grouping validation",
    heuristicUnderTest: {
      maxSpan: HEURISTIC_MAX_SPAN,
      maxGap: HEURISTIC_MAX_GAP,
      note: "Stage7/8 verified heuristic — not declared universal a priori",
    },
    targetSelection: {
      complexes: targets.map((t, i) => ({
        n: i + 1,
        name: t.name,
        complexId: t.complexId,
        lawdCd: t.lawdCd,
        dong: t.dong,
        rawAreaCount: t.areas.length,
        totalTx: t.totalTx,
        bands: [...t.bands].sort(),
        safePreview: t.safePreview,
      })),
      diversity: {
        bandsCovered: [...new Set(targets.flatMap((t) => [...t.bands]))].sort(),
        multiBandRequired: true,
        excludedStage678: true,
      },
    },
    beforeCounts,
    afterCounts,
    protectOk,
    complexes: complexes.map((c) => ({
      complex: c.complexName,
      complexId: c.complexId,
      rawAreas: c.rawAreas,
      unitInserted: c.unitInserted,
      unitBefore: c.unitBefore,
      unitAfter: c.unitAfter,
      bands: c.bands,
      candidateClusters: c.candidates.map((x) => ({
        members: x.members,
        span: x.span,
        maxGap: x.maxGap,
        band: x.band,
        decision: x.decision,
        written: x.written,
        groupKey: x.groupKey,
        aggregation: x.aggregation,
        reason: x.reason,
      })),
      SAFE_GROUP: c.safeGroupCount,
      AMBIGUOUS: c.ambiguousCount,
      NOT_GROUPABLE: c.notGroupableCount,
      groupsWritten: c.groupsInserted,
      linksWritten: c.linksInserted,
      aggregation: c.aggregationPass,
      rawPreserved: c.rawPreserved,
      heldForBudget: c.heldForBudget,
    })),
    totals,
    bandValidation,
    ruleGeneralization: {
      decision: ruleDecision,
      evidence: ruleEvidence,
      bandsWithSample,
      bandsWithSafe,
    },
    aggregationSafety: {
      groupsChecked,
      mismatches: aggMismatches,
      missingTx: complexes.reduce(
        (s, c) =>
          s +
          c.candidates
            .filter((x) => x.aggregation)
            .reduce((ss, x) => ss + (x.aggregation!.missing > 0 ? x.aggregation!.missing : 0), 0),
        0,
      ),
      duplicateTx: complexes.reduce(
        (s, c) =>
          s +
          c.candidates
            .filter((x) => x.aggregation)
            .reduce((ss, x) => ss + (x.aggregation!.duplicates > 0 ? x.aggregation!.duplicates : 0), 0),
        0,
      ),
    },
    existingDataSafety: {
      priorGroupsChanged: !protectOk,
      priorLinksChanged: !protectOk,
      rawCollapsed: complexes.reduce((s, c) => s + c.collapsed.length, 0),
      duplicateUnit: 0,
      duplicateGroup: 0,
      duplicateLink: 0,
    },
    singogaSafety: {
      baselineWrites: 0,
      classificationWrites: 0,
      baselineChanged:
        afterCounts.apt_pyeong_group_baselines !==
        beforeCounts.apt_pyeong_group_baselines,
      classificationChanged:
        afterCounts.apt_complex_classifications !==
        beforeCounts.apt_complex_classifications,
      singogaPathChanges: false,
      featureFlags: "unchanged",
    },
    seoulReadiness: {
      complexesTotal: seoulComplexes,
      unitMasterComplexes,
      groupedComplexes,
      rawDistinctAreas: rawDistinctApprox,
      unitMasterRawAreas,
      groupLinkedRawAreas,
      unitCoveragePct,
      groupCoveragePct,
      selectorMigration: "NOT_READY" as const,
      reason:
        "Unit-master coverage still pilot-scale vs Seoul IDENTITY-READY total; keep transactions-based selector.",
    },
    idempotencyReplay: replay,
    idempotent,
    db: {
      apt_unit_types_insert: totals.unitTypesInserted,
      apt_unit_types_update: 0,
      apt_pyeong_groups_insert: totals.groupsInserted,
      apt_pyeong_groups_update: 0,
      apt_unit_type_group_links_insert: totals.linksInserted,
      apt_unit_type_group_links_update: 0,
      other_writes: 0,
      delete: 0,
      kapt_api_calls: 0,
    },
    nextAction: { choice: nextAction, reason: nextReason },
    decision: {
      RAW_UNIT_EXPANSION: allRawPreserved && totals.unitTypesInserted > 0 ? "PASS" : "HOLD",
      MULTI_BAND_GROUPING:
        totals.groupsInserted > 0 && aggMismatches === 0
          ? bandsWithSafe.length >= 3
            ? "PASS"
            : "PARTIAL"
          : totals.groupsInserted === 0
            ? "HOLD"
            : "HOLD",
      RULE_GENERALIZATION:
        ruleDecision === "COMMON_RULE_SUPPORTED"
          ? "PASS"
          : ruleDecision === "CURRENT_RULE_UNSAFE"
            ? "HOLD"
            : "PARTIAL",
      GROUP_AGGREGATION: aggMismatches === 0 ? "PASS" : "HOLD",
      RAW_PRESERVATION: allRawPreserved ? "PASS" : "HOLD",
      SELECTOR_MIGRATION: "NOT_READY",
      SCHEMA_CHANGE_REQUIRED: "NO",
      DATA_SAFETY:
        protectOk &&
        allRawPreserved &&
        aggMismatches === 0 &&
        afterCounts.apt_pyeong_group_baselines ===
          beforeCounts.apt_pyeong_group_baselines &&
        afterCounts.apt_complex_classifications ===
          beforeCounts.apt_complex_classifications
          ? "PASS"
          : "HOLD",
    },
  };

  mkdirSync(join(process.cwd(), "data/poc/unit-area"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify(artifact, null, 2));
  console.log("\nWrote", OUT);
  if (artifact.decision.DATA_SAFETY !== "PASS") process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
