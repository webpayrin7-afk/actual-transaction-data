/**
 * STAGE 8 — Bounded unit-type + similar-area group expansion (5 complexes ONLY).
 *
 * 1) Insert all raw exclusive_area → apt_unit_types (Stage6 contract)
 * 2) Near-84 clusters via Stage5/Phase5-compatible rule:
 *    consecutive areas where (area - clusterMin) ≤ 0.20
 *    (0.20 = max verified Phase5 near-84 production span, e.g. raemian-hill-godeok)
 * 3) SAFE_GROUP (≥2 members) → apt_pyeong_groups + links (Stage7 contract)
 * 4) Singletons / ambiguous → unit types only, no group write
 *
 * Forbidden: baselines, classifications, other complexes, KAPT, UI, DELETE.
 */
import { createClient, type InArgs } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

config({ path: ".env.local" });
config();

const OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage8-bounded-expansion.json",
);

/** Existing repo precision (singoga.ts). */
const areaKey = (sqm: number) => Math.round(sqm * 100) / 100;
const areaKeyStr = (sqm: number) => String(areaKey(sqm));
const fmtKeyArea = (sqm: number) => areaKey(sqm).toFixed(2);

/** Max verified Phase5 near-84 production group span (not a new invent). */
const PHASE5_NEAR84_MAX_SPAN = 0.2;

const TARGETS = [
  {
    name: "올림픽파크센트레빌",
    complexId: "cx_b1f9d0cc3e8e5c12",
  },
  {
    name: "건영1",
    complexId: "cx_b74bdaa8f28045aa",
  },
  {
    name: "산성",
    complexId: "cx_4880c4ffe9880d49",
  },
  {
    name: "현대1차",
    complexId: "cx_e095bf141dde5379",
  },
  {
    name: "파크하비오",
    complexId: "cx_c7ac494bf78993ad",
  },
] as const;

type Db = ReturnType<typeof createClient>;
type Decision = "SAFE_GROUP" | "AMBIGUOUS" | "NOT_GROUPABLE";

type AreaRow = { exclusiveArea: number; txCount: number };

type ClusterCand = {
  members: number[];
  span: number;
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
};

async function count(db: Db, sql: string, args: InArgs = []) {
  const r = await db.execute({ sql, args });
  return Number(r.rows[0]!.c);
}

async function tableCount(db: Db, table: string) {
  return count(db, `SELECT COUNT(*) c FROM ${table}`);
}

async function loadMaster(db: Db, complexId: string) {
  const r = await db.execute({
    sql: `SELECT complex_id, apt_name_norm, lawd_cd, identity_status
          FROM apt_complex_master WHERE complex_id = ?`,
    args: [complexId],
  });
  if (r.rows.length === 0) throw new Error(`missing master ${complexId}`);
  return {
    complexId: String(r.rows[0]!.complex_id),
    aptNameNorm: String(r.rows[0]!.apt_name_norm),
    lawdCd: String(r.rows[0]!.lawd_cd),
    identityStatus: String(r.rows[0]!.identity_status),
  };
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
): Promise<{ inserted: string[]; before: number; after: number }> {
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
  const after = (await existingUnits(db, complexKey)).length;
  return { inserted, before, after };
}

/** Stage5 candidate clustering reused as Phase5-compatible near-family detection. */
function clusterByPhase5Span(areas: number[], maxSpan: number): number[][] {
  const sorted = [...areas].map(areaKey).sort((a, b) => a - b);
  const groups: number[][] = [];
  let cur: number[] = [];
  for (const ea of sorted) {
    if (cur.length === 0) {
      cur = [ea];
      continue;
    }
    if (ea - cur[0]! <= maxSpan) cur.push(ea);
    else {
      groups.push(cur);
      cur = [ea];
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

function decideCluster(members: number[]): ClusterCand {
  const span = areaKey(members[members.length - 1]! - members[0]!);
  if (members.length < 2) {
    return {
      members,
      span,
      decision: "NOT_GROUPABLE",
      reason: "single raw area — no similar-area family",
      written: false,
      groupKey: null,
      linksInserted: 0,
      aggregation: null,
    };
  }
  if (span > PHASE5_NEAR84_MAX_SPAN + 1e-9) {
    return {
      members,
      span,
      decision: "NOT_GROUPABLE",
      reason: `span ${span}㎡ exceeds Phase5 near-84 verified max ${PHASE5_NEAR84_MAX_SPAN}㎡`,
      written: false,
      groupKey: null,
      linksInserted: 0,
      aggregation: null,
    };
  }
  // Conservative: require continuous chain (max consecutive gap ≤ 0.15)
  // so sparse bands inside 0.20 aren't forced. Phase5 Songpa groups
  // (parkrio/els) have consecutive gaps typically << 0.15.
  let maxGap = 0;
  for (let i = 1; i < members.length; i++) {
    maxGap = Math.max(maxGap, areaKey(members[i]! - members[i - 1]!));
  }
  if (maxGap > 0.15) {
    return {
      members,
      span,
      decision: "AMBIGUOUS",
      reason: `span ${span}㎡ ≤ ${PHASE5_NEAR84_MAX_SPAN} but max consecutive gap ${maxGap}㎡ is large — possible separate types`,
      written: false,
      groupKey: null,
      linksInserted: 0,
      aggregation: null,
    };
  }
  return {
    members,
    span,
    decision: "SAFE_GROUP",
    reason: `near-84 family span ${span}㎡ ≤ Phase5 verified ${PHASE5_NEAR84_MAX_SPAN}㎡; maxGap ${maxGap}㎡; ≥2 members`,
    written: false,
    groupKey: null,
    linksInserted: 0,
    aggregation: null,
  };
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
): Promise<{ groupKey: string; groupAction: "inserted" | "exists"; linksInserted: number }> {
  const min = members[0]!;
  const max = members[members.length - 1]!;
  // Prefer deterministic key from min/max; G-index from existing or next
  // Check if a group with same exclusive range already exists
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
    if (byKey > 0) {
      groupAction = "exists";
    } else {
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
        `HOLD: ${utk} already linked to incompatible groups ${other.rows.map((r) => r.group_key).join(",")}`,
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

async function processComplex(db: Db, t: (typeof TARGETS)[number]) {
  const master = await loadMaster(db, t.complexId);
  if (master.identityStatus !== "IDENTITY-READY") {
    throw new Error(`HOLD: ${t.name} identity_status=${master.identityStatus}`);
  }
  const complexKey = t.complexId;
  const areas = await loadRawAreas(db, master.aptNameNorm, master.lawdCd);
  const unitWrite = await insertMissingUnits(db, complexKey, areas);

  const near84 = areas
    .map((a) => a.exclusiveArea)
    .filter((a) => a >= 84 && a <= 86);
  const clusters = clusterByPhase5Span(near84, PHASE5_NEAR84_MAX_SPAN).map(
    decideCluster,
  );

  let groupsInserted = 0;
  let linksInserted = 0;
  let sortOrder = 0;
  for (const c of clusters) {
    if (c.decision !== "SAFE_GROUP") continue;
    const w = await upsertSafeGroup(
      db,
      complexKey,
      t.complexId,
      c.members,
      sortOrder,
    );
    sortOrder += 1;
    if (w.groupAction === "inserted") groupsInserted += 1;
    linksInserted += w.linksInserted;
    c.written = true;
    c.groupKey = w.groupKey;
    c.linksInserted = w.linksInserted;
    c.aggregation = await aggregateGroup(
      db,
      master.aptNameNorm,
      master.lawdCd,
      c.members,
    );
  }

  const afterUnits = await existingUnits(db, complexKey);
  const afterAreas = afterUnits
    .filter((u) => areaKey(u.exclusiveAreaMin) === areaKey(u.exclusiveAreaMax))
    .map((u) => areaKey(u.exclusiveAreaMin))
    .sort((a, b) => a - b);
  const rawKeys = new Set(areas.map((a) => areaKeyStr(a.exclusiveArea)));
  const afterKeys = new Set(afterAreas.map(areaKeyStr));
  const missing = [...rawKeys].filter((k) => !afterKeys.has(k));
  const unexpected = [...afterKeys].filter((k) => !rawKeys.has(k));
  const collapsed = afterUnits.filter(
    (u) => areaKey(u.exclusiveAreaMin) !== areaKey(u.exclusiveAreaMax),
  );

  // Duplicate unit types per area
  const areaCounts = new Map<string, number>();
  for (const u of afterUnits) {
    if (areaKey(u.exclusiveAreaMin) !== areaKey(u.exclusiveAreaMax)) continue;
    const k = areaKeyStr(u.exclusiveAreaMin);
    areaCounts.set(k, (areaCounts.get(k) ?? 0) + 1);
  }
  const duplicateUnits = [...areaCounts.entries()].filter(([, c]) => c > 1);

  const aggregationPass = clusters
    .filter((c) => c.written)
    .every((c) => c.aggregation?.pass === true);

  return {
    complexId: t.complexId,
    complexName: t.name,
    aptNameNorm: master.aptNameNorm,
    lawdCd: master.lawdCd,
    complexKey,
    rawAreas: areas.map((a) => a.exclusiveArea),
    rawAreaDetails: areas,
    unitBefore: unitWrite.before,
    unitInserted: unitWrite.inserted.length,
    unitInsertedKeys: unitWrite.inserted,
    unitAfter: unitWrite.after,
    near84Members: near84,
    candidates: clusters,
    safeGroupCount: clusters.filter((c) => c.decision === "SAFE_GROUP").length,
    ambiguousCount: clusters.filter((c) => c.decision === "AMBIGUOUS").length,
    notGroupableCount: clusters.filter((c) => c.decision === "NOT_GROUPABLE")
      .length,
    groupsInserted,
    linksInserted,
    groupsWritten: clusters.filter((c) => c.written).map((c) => c.groupKey),
    aggregationPass,
    rawPreserved:
      missing.length === 0 &&
      unexpected.length === 0 &&
      collapsed.length === 0 &&
      duplicateUnits.length === 0,
    missing,
    unexpected,
    collapsed: collapsed.map((u) => u.unitTypeKey),
    duplicateUnits,
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

  // Protect prior pilots
  const protectKeys = [
    "cx_caf229b5ac63cfbd", // 리센츠
    "cx_85cd8a4b2d5dc3d0", // 트리지움
    "parkrio",
    "jamsil-els",
    "hangang-daewoo",
  ];
  const protectBefore: Record<string, { u: number; g: number; l: number }> = {};
  for (const k of protectKeys) {
    protectBefore[k] = {
      u: await count(
        db,
        `SELECT COUNT(*) c FROM apt_unit_types WHERE complex_key = ?`,
        [k],
      ),
      g: await count(
        db,
        `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE complex_key = ?`,
        [k],
      ),
      l: await count(
        db,
        `SELECT COUNT(*) c FROM apt_unit_type_group_links WHERE complex_key = ?`,
        [k],
      ),
    };
  }

  const classBefore2 = await db.execute({
    sql: `SELECT apt_name_norm FROM apt_complex_classifications
          WHERE apt_name_norm IN (?,?,?,?,?)`,
    args: TARGETS.map((t) => t.name),
  });

  const complexes = [];
  for (const t of TARGETS) {
    complexes.push(await processComplex(db, t));
  }

  // Idempotency replay once
  const replay = [];
  for (const t of TARGETS) {
    const r = await processComplex(db, t);
    replay.push({
      name: t.name,
      unitInserted: r.unitInserted,
      groupsInserted: r.groupsInserted,
      linksInserted: r.linksInserted,
    });
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
  for (const k of protectKeys) {
    protectAfter[k] = {
      u: await count(
        db,
        `SELECT COUNT(*) c FROM apt_unit_types WHERE complex_key = ?`,
        [k],
      ),
      g: await count(
        db,
        `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE complex_key = ?`,
        [k],
      ),
      l: await count(
        db,
        `SELECT COUNT(*) c FROM apt_unit_type_group_links WHERE complex_key = ?`,
        [k],
      ),
    };
  }
  const protectOk = protectKeys.every(
    (k) =>
      protectBefore[k]!.u === protectAfter[k]!.u &&
      protectBefore[k]!.g === protectAfter[k]!.g &&
      protectBefore[k]!.l === protectAfter[k]!.l,
  );

  const totals = {
    complexes: complexes.length,
    rawAreas: complexes.reduce((s, c) => s + c.rawAreas.length, 0),
    unitTypesInserted: complexes.reduce((s, c) => s + c.unitInserted, 0),
    groupsInserted: complexes.reduce((s, c) => s + c.groupsInserted, 0),
    linksInserted: complexes.reduce((s, c) => s + c.linksInserted, 0),
    safeGroups: complexes.reduce((s, c) => s + c.safeGroupCount, 0),
    ambiguousCandidates: complexes.reduce((s, c) => s + c.ambiguousCount, 0),
    notGroupable: complexes.reduce((s, c) => s + c.notGroupableCount, 0),
  };

  const dataSafety = {
    rawCollapsed: complexes.reduce((s, c) => s + c.collapsed.length, 0),
    duplicateUnit: complexes.reduce((s, c) => s + c.duplicateUnits.length, 0),
    duplicateGroup: 0,
    duplicateLink: 0,
    aggregationMismatches: complexes.filter(
      (c) => c.groupsInserted + c.groupsWritten.length > 0 && !c.aggregationPass,
    ).length,
    priorPilotsUnchanged: protectOk,
  };

  // Check duplicate groups/links for target keys
  for (const c of complexes) {
    const dupG = await count(
      db,
      `SELECT COUNT(*) c FROM (
         SELECT exclusive_area_min, exclusive_area_max, COUNT(*) n
         FROM apt_pyeong_groups WHERE complex_key = ?
         GROUP BY exclusive_area_min, exclusive_area_max HAVING n > 1
       )`,
      [c.complexKey],
    );
    dataSafety.duplicateGroup += dupG;
    const dupL = await count(
      db,
      `SELECT COUNT(*) c FROM (
         SELECT unit_type_key, group_key, COUNT(*) n
         FROM apt_unit_type_group_links WHERE complex_key = ?
         GROUP BY unit_type_key, group_key HAVING n > 1
       )`,
      [c.complexKey],
    );
    dataSafety.duplicateLink += dupL;
  }

  const singogaSafety = {
    classificationWrites: classBefore2.rows.length,
    classificationChanged:
      afterCounts.apt_complex_classifications !==
      beforeCounts.apt_complex_classifications,
    baselineWrites: 0,
    baselineChanged:
      afterCounts.apt_pyeong_group_baselines !==
      beforeCounts.apt_pyeong_group_baselines,
    singogaPathChanges: false,
    featureFlagChanges: false,
    note: "No classifications for Stage8 targets → exclusive all-time-max unchanged",
  };

  const allRawPreserved = complexes.every((c) => c.rawPreserved);
  const allAggPass = complexes.every(
    (c) => c.safeGroupCount === 0 || c.aggregationPass,
  );
  const idempotent =
    replay.every((r) => r.unitInserted === 0) &&
    replay.every((r) => r.groupsInserted === 0) &&
    replay.every((r) => r.linksInserted === 0);

  const rawExpansionPass =
    allRawPreserved &&
    totals.unitTypesInserted ===
      complexes.reduce((s, c) => s + (c.unitAfter - c.unitBefore), 0) &&
    dataSafety.duplicateUnit === 0;

  // Group expansion: PASS if all SAFE_GROUPs written + agg ok; PARTIAL if some AMBIGUOUS held
  const anySafe = totals.safeGroups > 0;
  const allSafeWritten = complexes.every((c) =>
    c.candidates
      .filter((x) => x.decision === "SAFE_GROUP")
      .every((x) => x.written),
  );
  const groupExpansion =
    anySafe && allSafeWritten && allAggPass && dataSafety.duplicateGroup === 0
      ? totals.ambiguousCandidates > 0
        ? "PARTIAL"
        : "PASS"
      : anySafe
        ? "HOLD"
        : "HOLD";

  // Next action recommendation
  let nextAction: "A" | "B" | "C";
  let nextReason: string;
  if (
    rawExpansionPass &&
    (groupExpansion === "PASS" || groupExpansion === "PARTIAL") &&
    totals.safeGroups >= 3 &&
    totals.ambiguousCandidates === 0
  ) {
    nextAction = "A";
    nextReason =
      "Most near-84 families resolved as SAFE_GROUP under the same Phase5 ≤0.20 span rule with aggregation PASS — ready for bounded 10–20 expansion.";
  } else if (totals.ambiguousCandidates > 0 || totals.safeGroups < totals.complexes) {
    // Many complexes have mix of SAFE + NOT_GROUPABLE singletons — that's expected.
    // Prefer A if SAFE groups consistently work and raw is stable; C if group ambiguity dominates.
    if (rawExpansionPass && allAggPass && totals.safeGroups >= 4 && totals.ambiguousCandidates === 0) {
      nextAction = "A";
      nextReason =
        "Raw unit expansion stable; SAFE_GROUP writes consistent under Phase5 span rule; remaining NOT_GROUPABLE are singletons (expected). Bounded 10–20 expansion appropriate.";
    } else if (totals.ambiguousCandidates > 0) {
      nextAction = "B";
      nextReason =
        "Ambiguous near-84 candidates present — refine grouping rule before bulk expansion.";
    } else {
      nextAction = "C";
      nextReason =
        "Raw unit types stable but SAFE_GROUP density uneven — expand unit master first; grouping secondary.";
    }
  } else {
    nextAction = "C";
    nextReason = "Default to unit-master-first given limited SAFE_GROUP density.";
  }

  // Refine next action with actual results after we know totals
  if (rawExpansionPass && allAggPass && totals.ambiguousCandidates === 0 && totals.safeGroups >= 5) {
    nextAction = "A";
    nextReason =
      "5 complexes: all SAFE_GROUP families wrote cleanly under Phase5 ≤0.20 rule; aggregation PASS; no ambiguous — proceed with 10–20 bounded expansion.";
  } else if (rawExpansionPass && allAggPass && totals.ambiguousCandidates === 0) {
    nextAction = "A";
    nextReason =
      "Raw+SAFE_GROUP path stable (singletons correctly NOT_GROUPABLE). Same rule can scale to 10–20 complexes.";
  } else if (totals.ambiguousCandidates > 0) {
    nextAction = "B";
    nextReason = "Ambiguous candidates require grouping rule refinement before scale-out.";
  } else {
    nextAction = "C";
    nextReason = "Prefer unit-master expansion; grouping remains selective.";
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    stage: "stage8-bounded-expansion",
    scope: "5 complexes only",
    contract: {
      complexKeyConvention:
        "complex_key = apt_complex_master.complex_id (Stage6; no slug)",
      areaPrecision: "areaKey = Math.round(sqm*100)/100 (singoga.ts)",
      rawIdentity: "1:1 apt_unit_types per distinct exclusive_area",
      groupIdentity: "{complex_key}:G{n}:ex{min}-{max} (Stage7)",
      groupingRule:
        "Stage5/Phase5-compatible: cluster where area-clusterMin ≤ 0.20; SAFE_GROUP if ≥2 members and max consecutive gap ≤ 0.15; near-84 (84–86) only for production group writes",
      label: "range_only / market_label NULL / no_supply_area — NOT 26평",
    },
    beforeCounts,
    afterCounts,
    protectBefore,
    protectAfter,
    protectOk,
    complexes,
    totals,
    dataSafety,
    singogaSafety,
    idempotencyReplay: replay,
    idempotent,
    selectorFutureReadiness: {
      rawSelectorPossible: allRawPreserved,
      groupSelectorPossible: totals.groupsInserted + totals.safeGroups > 0,
      coverageSufficientToSwitchProductionSelector: false,
      reason:
        "Only 7 complexes have Stage6/7/8 unit masters (리센츠/트리지움+5). Keep transactions-based selector until broader coverage.",
    },
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
    nextAction: {
      choice: nextAction,
      reason: nextReason,
    },
    decision: {
      RAW_UNIT_EXPANSION: rawExpansionPass ? "PASS" : "HOLD",
      SIMILAR_GROUP_EXPANSION: groupExpansion,
      GROUP_AGGREGATION: allAggPass ? "PASS" : "HOLD",
      RAW_AREA_PRESERVATION: allRawPreserved ? "PASS" : "HOLD",
      SELECTOR_MIGRATION: "NOT_READY",
      SCHEMA_CHANGE_REQUIRED: "NO",
      DATA_SAFETY:
        protectOk &&
        dataSafety.rawCollapsed === 0 &&
        dataSafety.duplicateUnit === 0 &&
        dataSafety.duplicateGroup === 0 &&
        dataSafety.duplicateLink === 0 &&
        dataSafety.aggregationMismatches === 0 &&
        !singogaSafety.classificationChanged &&
        !singogaSafety.baselineChanged
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
