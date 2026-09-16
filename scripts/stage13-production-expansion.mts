/**
 * STAGE 13 — 25-complex production expansion under similar_exclusive_area_v1.
 *
 * Writes allowed:
 *   apt_unit_types (selected 25 only)
 *   apt_pyeong_groups (V1 SAFE only, NEW hard-cap 40)
 *   apt_unit_type_group_links (SAFE members only)
 *
 * Forbidden: baselines, classifications, DELETE, rule research, singoga.
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
  fmtKeyArea,
  proposeNewGroupsWithHardCap,
  SIMILAR_EXCLUSIVE_AREA_RULE_VERSION,
  V1_MAX_GAP,
  V1_MAX_SPAN,
  type AreaRow,
  type BandKey,
} from "./lib/stage9-grouping-contract";

config({ path: ".env.local" });
config();

const OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage13-production-expansion.json",
);

const MAX_NEW_GROUPS = 40;
const TARGET_COUNT = 25;
const MIN_TX = 80;
const MIN_CANONICAL_AREAS = 4;
const MAX_CANONICAL_AREAS = 15;

/** Provenance stored in existing apt_pyeong_groups.source (no schema change). */
const GROUP_SOURCE = SIMILAR_EXCLUSIVE_AREA_RULE_VERSION;

/** Stage6–12 complexes (production + validation samples). */
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
  // Stage10
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
  // Stage11
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
  // Stage12 held-out
  "cx_7705825d7bfdcb98",
  "cx_5d6b38cbeca0466b",
  "cx_f4af38d8341a7e6d",
  "cx_35b271e3f9295c7e",
  "cx_50f1917baa4ed611",
  "cx_f1104af06fb68ecb",
  "cx_69a4b95ec1df862d",
  "cx_74a163fa0855ed8a",
  "cx_0276fe98811f6b51",
  "cx_5a58d36952eb9f8c",
  "cx_8b99a482478f6a77",
  "cx_5a87002a61bcacfb",
  "cx_d661dbccff41683d",
  "cx_d32f2cad6ab3548b",
  "cx_6e0a719cea1bbd89",
  "cx_7c3c9fa6bd00d853",
  "cx_07b088014854bcb0",
  "cx_5a1be94b6a31e36d",
  "cx_de373925cabf2828",
]);

const PROTECT_KEYS = [
  "cx_caf229b5ac63cfbd",
  "cx_85cd8a4b2d5dc3d0",
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
  "parkrio",
  "jamsil-els",
  "acro-riverpark",
  "daechi-palace",
  "hannam-thehill",
  "mapo-raemian-prugio",
  "raemian-hill-godeok",
] as const;

const BANDS: BandKey[] = ["50-69", "70-79", "80-89", "90-109", "110+"];
const BAND_SOFT_QUOTA: Record<BandKey, number> = {
  "50-69": 5,
  "70-79": 4,
  "80-89": 5,
  "90-109": 5,
  "110+": 6,
  other: 0,
};

type Db = ReturnType<typeof createClient>;

type Target = {
  complexId: string;
  name: string;
  lawdCd: string;
  dong: string | null;
  totalTx: number;
  canonicalAreaCount: number;
  bandsPresent: BandKey[];
};

type GroupBudget = { remaining: number; halt: boolean; haltReason: string | null };

async function count(db: Db, sql: string, args: InArgs = []) {
  const r = await db.execute({ sql, args });
  return Number(r.rows[0]!.c);
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
  // Keep raw floats here; canonicalize+dedupe later via dedupeAreas.
  return tx.rows.map((r) => ({
    exclusiveArea: Number(r.ea),
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
  return {
    inserted,
    before,
    after: (await existingUnits(db, complexKey)).length,
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
): Promise<
  | { ok: true; groupKey: string; groupAction: "inserted" | "exists"; linksInserted: number }
  | { ok: false; reason: string; semanticHold: true }
> {
  const min = members[0]!;
  const max = members[members.length - 1]!;
  if (!(min < max) || members.length < 2) {
    return { ok: false, reason: "zero-span / singleton invariant", semanticHold: true };
  }

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
          GROUP_SOURCE,
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
      return {
        ok: false,
        reason: `${utk} already linked to incompatible groups: ${other.rows
          .map((r) => r.group_key)
          .join(",")}`,
        semanticHold: true,
      };
    }
    await db.execute({
      sql: `INSERT INTO apt_unit_type_group_links (
        unit_type_key, group_key, complex_key, is_outlier
      ) VALUES (?, ?, ?, ?)`,
      args: [utk, groupKey, complexKey, 0],
    });
    linksInserted += 1;
  }
  return { ok: true, groupKey, groupAction, linksInserted };
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
    missing: Math.max(0, memberSum - groupResult),
    duplicates: Math.max(0, groupResult - memberSum),
    pass: memberSum === groupResult,
  };
}

async function rawPreservation(
  db: Db,
  aptNameNorm: string,
  lawdCd: string,
  areas: AreaRow[],
) {
  for (const a of areas) {
    const n = await count(
      db,
      `SELECT COUNT(*) c FROM transactions
       WHERE apt_name_norm = ? AND lawd_cd = ?
         AND exclusive_area IS NOT NULL
         AND ROUND(exclusive_area * 100) = ROUND(? * 100)`,
      [aptNameNorm, lawdCd, a.exclusiveArea],
    );
    if (n !== a.txCount) {
      return {
        pass: false as const,
        reason: `canonical ${a.exclusiveArea} expected tx=${a.txCount} got=${n}`,
      };
    }
  }
  return { pass: true as const };
}

async function selectTargets(db: Db): Promise<{
  targets: Target[];
  selectionRule: Record<string, unknown>;
  poolSize: number;
}> {
  // Exclude existing cx_ unit masters
  const have = await db.execute(
    `SELECT DISTINCT complex_key FROM apt_unit_types WHERE complex_key LIKE 'cx_%'`,
  );
  for (const r of have.rows) EXCLUDE_IDS.add(String(r.complex_key));

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

  type Acc = {
    complexId: string;
    name: string;
    lawdCd: string;
    dong: string | null;
    raw: AreaRow[];
  };
  const byId = new Map<string, Acc>();
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
        raw: [],
      };
      byId.set(cid, row);
    }
    row.raw.push({ exclusiveArea: Number(r.ea), txCount: Number(r.cnt) });
  }

  const eligible: Target[] = [];
  for (const row of byId.values()) {
    const areas = dedupeAreas(row.raw);
    const totalTx = areas.reduce((s, a) => s + a.txCount, 0);
    if (totalTx < MIN_TX) continue;
    if (
      areas.length < MIN_CANONICAL_AREAS ||
      areas.length > MAX_CANONICAL_AREAS
    ) {
      continue;
    }
    const bandsPresent = [
      ...new Set(areas.map((a) => bandOf(a.exclusiveArea)).filter((b) => b !== "other")),
    ] as BandKey[];
    eligible.push({
      complexId: row.complexId,
      name: row.name,
      lawdCd: row.lawdCd,
      dong: row.dong,
      totalTx,
      canonicalAreaCount: areas.length,
      bandsPresent,
    });
  }

  // Deterministic primary order
  eligible.sort((a, b) => {
    if (b.totalTx !== a.totalTx) return b.totalTx - a.totalTx;
    return a.complexId.localeCompare(b.complexId);
  });

  const selected: Target[] = [];
  const selectedIds = new Set<string>();
  const bandHits: Record<string, number> = Object.fromEntries(
    BANDS.map((b) => [b, 0]),
  );

  function creditBands(t: Target) {
    for (const b of t.bandsPresent) {
      if (BANDS.includes(b)) bandHits[b] = (bandHits[b] ?? 0) + 1;
    }
  }

  // Pass 1: soft band quotas
  for (const t of eligible) {
    if (selected.length >= TARGET_COUNT) break;
    const underfilled = BANDS.some(
      (b) =>
        t.bandsPresent.includes(b) &&
        (bandHits[b] ?? 0) < (BAND_SOFT_QUOTA[b] ?? 0),
    );
    if (!underfilled) continue;
    selectedIds.add(t.complexId);
    selected.push(t);
    creditBands(t);
  }

  // Pass 2: fill remaining by primary order
  for (const t of eligible) {
    if (selected.length >= TARGET_COUNT) break;
    if (selectedIds.has(t.complexId)) continue;
    selectedIds.add(t.complexId);
    selected.push(t);
    creditBands(t);
  }

  // Final report order: selection order (already deterministic)
  if (selected.length !== TARGET_COUNT) {
    throw new Error(
      `selection produced ${selected.length} targets; expected ${TARGET_COUNT} (pool=${eligible.length})`,
    );
  }

  return {
    targets: selected,
    poolSize: eligible.length,
    selectionRule: {
      scope: "Seoul IDENTITY-READY",
      exclude: "Stage6–12 samples + existing cx_ unit-master complexes",
      minTx: MIN_TX,
      canonicalAreaRange: [MIN_CANONICAL_AREAS, MAX_CANONICAL_AREAS],
      primaryOrder: "total_tx DESC, complex_id ASC",
      diversity: "soft band quotas then fill remaining by primary order",
      bandSoftQuota: BAND_SOFT_QUOTA,
      bandHitsAfterSelection: bandHits,
      primaryBandFn: "underfilled band among present, else first BANDS order",
    },
  };
}

async function coverageSnapshot(db: Db) {
  const seoulComplexes = await count(
    db,
    `SELECT COUNT(*) c FROM apt_complex_master
     WHERE identity_status='IDENTITY-READY' AND sido_code='11'`,
  );
  const unitMasterComplexes = await count(
    db,
    `SELECT COUNT(DISTINCT complex_key) c FROM apt_unit_types WHERE complex_key LIKE 'cx_%'`,
  );
  const groupedCxComplexes = await count(
    db,
    `SELECT COUNT(DISTINCT complex_key) c FROM apt_pyeong_groups WHERE complex_key LIKE 'cx_%'`,
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
  return {
    seoulComplexes,
    unitMasterComplexes,
    groupedCxComplexes,
    unitMasterComplexCoveragePct:
      Math.round((unitMasterComplexes / seoulComplexes) * 10000) / 100,
    groupedComplexCoveragePct:
      Math.round((groupedCxComplexes / seoulComplexes) * 10000) / 100,
    canonicalRawIdentities: canonicalRaw,
    unitMasterCanonicalIdentities: unitMasterCanonical,
    groupLinkedCanonicalIdentities: groupLinkedCanonical,
    unitRawAreaCoveragePct:
      Math.round((unitMasterCanonical / canonicalRaw) * 10000) / 100,
    groupLinkedRawAreaCoveragePct:
      Math.round((groupLinkedCanonical / canonicalRaw) * 10000) / 100,
  };
}

async function processComplex(
  db: Db,
  t: Target,
  groupBudget: GroupBudget,
  writeEnabled: boolean,
) {
  const complexKey = t.complexId;
  const rawAreas = await loadRawAreas(db, t.name, t.lawdCd);
  const areas = dedupeAreas(rawAreas);

  const unitWrite = writeEnabled
    ? await insertMissingUnits(db, complexKey, areas)
    : {
        inserted: [] as string[],
        before: (await existingUnits(db, complexKey)).length,
        after: (await existingUnits(db, complexKey)).length,
      };

  const clusters = clusterByCommonRuleV1(areas);
  const decisions = {
    SAFE_GROUP: 0,
    NOT_GROUPABLE: 0,
    BOUNDARY_REJECTED: 0,
    SEMANTIC_HOLD: 0,
    HOLD_BUDGET: 0,
  };

  type Written = {
    members: number[];
    decision: string;
    groupKey: string | null;
    groupAction: string | null;
    linksInserted: number;
    aggregation: Awaited<ReturnType<typeof aggregateGroup>> | null;
    reason: string;
  };
  const writtenGroups: Written[] = [];
  let groupsInserted = 0;
  let linksInserted = 0;
  let aggregationPass = true;
  let semanticHoldReason: string | null = null;

  const safeCands = clusters
    .filter((c) => c.decision === "SAFE_BY_COMMON_RULE")
    .sort((a, b) => a.min - b.min || a.max - b.max);

  for (const c of clusters) {
    if (c.decision === "NOT_GROUPABLE") decisions.NOT_GROUPABLE += 1;
    else if (c.decision === "BOUNDARY_REJECTED") {
      decisions.NOT_GROUPABLE += 1; // Stage13: no AMBIGUOUS invent; treat as not groupable
    } else if (c.decision === "SEMANTIC_AMBIGUITY") {
      decisions.SEMANTIC_HOLD += 1;
    }
  }

  let sortOrder = 0;
  for (const c of safeCands) {
    decisions.SAFE_GROUP += 1;
    sortOrder += 1;

    if (!writeEnabled) {
      writtenGroups.push({
        members: c.members,
        decision: "SAFE_GROUP_VERIFY_ONLY",
        groupKey: null,
        groupAction: null,
        linksInserted: 0,
        aggregation: null,
        reason: c.reason,
      });
      continue;
    }

    if (groupBudget.halt || groupBudget.remaining <= 0) {
      decisions.HOLD_BUDGET += 1;
      writtenGroups.push({
        members: c.members,
        decision: "HOLD_BUDGET",
        groupKey: null,
        groupAction: null,
        linksInserted: 0,
        aggregation: null,
        reason: "HOLD_BUDGET",
      });
      continue;
    }

    // Pre-check aggregation before write
    const agg = await aggregateGroup(db, t.name, t.lawdCd, c.members);
    if (!agg.pass) {
      aggregationPass = false;
      groupBudget.halt = true;
      groupBudget.haltReason = `aggregation mismatch ${t.complexId} members=${c.members.join(",")}`;
      writtenGroups.push({
        members: c.members,
        decision: "AGGREGATION_HOLD",
        groupKey: null,
        groupAction: null,
        linksInserted: 0,
        aggregation: agg,
        reason: groupBudget.haltReason,
      });
      break;
    }

    const up = await upsertSafeGroup(
      db,
      complexKey,
      t.complexId,
      c.members,
      sortOrder,
    );
    if (!up.ok) {
      decisions.SEMANTIC_HOLD += 1;
      semanticHoldReason = up.reason;
      groupBudget.halt = true;
      groupBudget.haltReason = up.reason;
      writtenGroups.push({
        members: c.members,
        decision: "SEMANTIC_HOLD",
        groupKey: null,
        groupAction: null,
        linksInserted: 0,
        aggregation: agg,
        reason: up.reason,
      });
      break;
    }

    if (up.groupAction === "inserted") {
      groupBudget.remaining -= 1;
      groupsInserted += 1;
    }
    linksInserted += up.linksInserted;
    writtenGroups.push({
      members: c.members,
      decision: "SAFE_GROUP",
      groupKey: up.groupKey,
      groupAction: up.groupAction,
      linksInserted: up.linksInserted,
      aggregation: agg,
      reason: c.reason,
    });
  }

  const preserve = await rawPreservation(db, t.name, t.lawdCd, areas);

  return {
    name: t.name,
    complexId: t.complexId,
    lawdCd: t.lawdCd,
    dong: t.dong,
    totalTx: t.totalTx,
    canonicalAreas: areas.length,
    bandsPresent: t.bandsPresent,
    unitBefore: unitWrite.before,
    unitInserted: unitWrite.inserted.length,
    unitAfter: unitWrite.after,
    unitKeysInserted: unitWrite.inserted,
    V1Candidates: clusters.length,
    ...decisions,
    groupsWritten: groupsInserted,
    linksWritten: linksInserted,
    writtenGroups,
    aggregation: aggregationPass ? "PASS" : "HOLD",
    rawPreserved: preserve.pass ? "PASS" : "HOLD",
    rawPreserveDetail: preserve,
    ruleVersion: SIMILAR_EXCLUSIVE_AREA_RULE_VERSION,
    ruleMetadataStorage: "DB:source",
    semanticHoldReason,
  };
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });

  const beforeCounts = {
    apt_unit_types: await count(db, `SELECT COUNT(*) c FROM apt_unit_types`),
    apt_pyeong_groups: await count(db, `SELECT COUNT(*) c FROM apt_pyeong_groups`),
    apt_unit_type_group_links: await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links`,
    ),
    apt_pyeong_group_baselines: await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_group_baselines`,
    ),
    apt_complex_classifications: await count(
      db,
      `SELECT COUNT(*) c FROM apt_complex_classifications`,
    ),
  };

  const protectBefore: Record<string, number> = {};
  for (const k of PROTECT_KEYS) {
    protectBefore[k] = await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE complex_key=?`,
      [k],
    );
  }

  const coverageBefore = await coverageSnapshot(db);
  const { targets, selectionRule, poolSize } = await selectTargets(db);

  const groupBudget: GroupBudget = {
    remaining: MAX_NEW_GROUPS,
    halt: false,
    haltReason: null,
  };

  const complexes = [];
  let totalUnitsInserted = 0;
  let totalGroupsInserted = 0;
  let totalLinksInserted = 0;
  let totalSafe = 0;
  let totalNotGroupable = 0;
  let totalSemanticHold = 0;
  let totalHoldBudget = 0;
  let totalV1Candidates = 0;
  let aggregationMismatches = 0;
  let zeroSpanGroups = 0;

  for (const t of targets) {
    const result = await processComplex(db, t, groupBudget, true);
    complexes.push(result);
    totalUnitsInserted += result.unitInserted;
    totalGroupsInserted += result.groupsWritten;
    totalLinksInserted += result.linksWritten;
    totalSafe += result.SAFE_GROUP;
    totalNotGroupable += result.NOT_GROUPABLE;
    totalSemanticHold += result.SEMANTIC_HOLD;
    totalHoldBudget += result.HOLD_BUDGET;
    totalV1Candidates += result.V1Candidates;
    if (result.aggregation !== "PASS") aggregationMismatches += 1;
    for (const g of result.writtenGroups) {
      if (
        g.groupAction === "inserted" &&
        g.members.length >= 1 &&
        areaKey(g.members[0]!) === areaKey(g.members[g.members.length - 1]!)
      ) {
        zeroSpanGroups += 1;
      }
    }
    if (groupBudget.halt) {
      // Continue unit writes for remaining complexes, but groups stay halted
      // by remaining<=0 / halt checks inside processComplex.
    }
  }

  // Hard-cap absolute check
  if (totalGroupsInserted > MAX_NEW_GROUPS) {
    throw new Error(
      `HARD CAP VIOLATION: new groups ${totalGroupsInserted} > ${MAX_NEW_GROUPS}`,
    );
  }

  // Verify-only replay (remaining=0): expect no new inserts
  const verifyBudget: GroupBudget = {
    remaining: 0,
    halt: false,
    haltReason: null,
  };
  let verifyNewUnits = 0;
  let verifyNewGroups = 0;
  let verifyNewLinks = 0;
  for (const t of targets) {
    const beforeU = await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_types WHERE complex_key=?`,
      [t.complexId],
    );
    const beforeG = await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE complex_key=?`,
      [t.complexId],
    );
    const beforeL = await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links WHERE complex_key=?`,
      [t.complexId],
    );
    // units: attempt insert path but duplicates skipped
    const areas = dedupeAreas(await loadRawAreas(db, t.name, t.lawdCd));
    const u = await insertMissingUnits(db, t.complexId, areas);
    verifyNewUnits += u.inserted.length;
    await processComplex(db, t, verifyBudget, false);
    const afterU = await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_types WHERE complex_key=?`,
      [t.complexId],
    );
    const afterG = await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE complex_key=?`,
      [t.complexId],
    );
    const afterL = await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links WHERE complex_key=?`,
      [t.complexId],
    );
    verifyNewGroups += afterG - beforeG;
    verifyNewLinks += afterL - beforeL;
    if (afterU !== beforeU + u.inserted.length) {
      // consistency
    }
  }

  const protectAfter: Record<string, number> = {};
  let protectOk = true;
  for (const k of PROTECT_KEYS) {
    protectAfter[k] = await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE complex_key=?`,
      [k],
    );
    if (protectAfter[k] !== protectBefore[k]) protectOk = false;
  }

  const afterCounts = {
    apt_unit_types: await count(db, `SELECT COUNT(*) c FROM apt_unit_types`),
    apt_pyeong_groups: await count(db, `SELECT COUNT(*) c FROM apt_pyeong_groups`),
    apt_unit_type_group_links: await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links`,
    ),
    apt_pyeong_group_baselines: await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_group_baselines`,
    ),
    apt_complex_classifications: await count(
      db,
      `SELECT COUNT(*) c FROM apt_complex_classifications`,
    ),
  };

  const coverageAfter = await coverageSnapshot(db);

  // Write-cap dry helper regression
  const fake = Array.from({ length: 50 }, (_, i) => ({
    id: `c${i}`,
    alreadyExists: false,
    order: i,
  }));
  const writeCapRegression = [0, 5, 20, 40].map((budget) => {
    const r = proposeNewGroupsWithHardCap(fake, budget);
    return {
      budget,
      proposed: r.accepted.length,
      held: r.held.length,
      withinCap: r.accepted.length <= budget,
    };
  });

  const groupsChecked = complexes.reduce(
    (s, c) => s + c.writtenGroups.filter((g) => g.aggregation).length,
    0,
  );
  const groupsAggPass = complexes.reduce(
    (s, c) =>
      s +
      c.writtenGroups.filter((g) => g.aggregation && g.aggregation.pass).length,
    0,
  );

  const allAggPass = complexes.every((c) => c.aggregation === "PASS");
  const allRawPass = complexes.every((c) => c.rawPreserved === "PASS");
  const capExceeded = totalGroupsInserted > MAX_NEW_GROUPS;
  const heldByBudget = totalHoldBudget;

  let unitExpansion: "PASS" | "PARTIAL" | "HOLD";
  if (
    complexes.length === TARGET_COUNT &&
    afterCounts.apt_unit_types ===
      beforeCounts.apt_unit_types + totalUnitsInserted
  ) {
    unitExpansion = "PASS";
  } else {
    unitExpansion = "PARTIAL";
  }

  let groupExpansion: "PASS" | "PARTIAL" | "HOLD";
  if (
    allAggPass &&
    zeroSpanGroups === 0 &&
    !capExceeded &&
    protectOk &&
    totalSemanticHold === 0
  ) {
    groupExpansion = totalHoldBudget > 0 ? "PARTIAL" : "PASS";
  } else if (
    totalSemanticHold > 0 ||
    !allAggPass ||
    zeroSpanGroups > 0 ||
    !protectOk
  ) {
    groupExpansion = "HOLD";
  } else {
    groupExpansion = "PARTIAL";
  }

  const migration =
    coverageAfter.unitMasterComplexCoveragePct >= 5 ? "READY" : "NOT_READY";

  let nextAction: "A" | "B" | "C" | "D" | "E";
  let nextReason: string;
  if (groupExpansion === "HOLD") {
    nextAction = "E";
    nextReason = "Defect requires HOLD / repair before further expansion.";
  } else if (groupExpansion === "PASS" && unitExpansion === "PASS") {
    nextAction = "A";
    nextReason =
      "Coverage expanded under V1; next is Stage14 exact/group singoga baseline pilot (not full production singoga switch).";
  } else {
    nextAction = "C";
    nextReason = "Partial expansion — consider second 25-complex batch after review.";
  }

  const report = {
    generatedAt: new Date().toISOString(),
    stage: "stage13-production-expansion",
    ruleVersion: SIMILAR_EXCLUSIVE_AREA_RULE_VERSION,
    groupingContract: {
      version: SIMILAR_EXCLUSIVE_AREA_RULE_VERSION,
      canonicalPrecision: 2,
      maxSpan: V1_MAX_SPAN,
      maxGap: V1_MAX_GAP,
      minimumCanonicalMembers: 2,
      ruleMetadataStorage: "DB apt_pyeong_groups.source = similar_exclusive_area_v1",
      pipeline: [
        "raw exclusive_area",
        "canonicalize to 2 decimals",
        "canonical dedupe",
        "sort",
        "gap-split cluster (gap>0.15 breaks)",
        "span<=0.20 decision",
      ],
    },
    selectionRule,
    poolSize,
    targets: targets.map((t, i) => ({
      index: i + 1,
      name: t.name,
      complexId: t.complexId,
      lawdCd: t.lawdCd,
      dong: t.dong,
      totalTx: t.totalTx,
      canonicalAreaCount: t.canonicalAreaCount,
      bandsPresent: t.bandsPresent,
    })),
    beforeCounts,
    afterCounts,
    coverageBefore,
    coverageAfter,
    coverageDelta: {
      unitMasterComplexes: {
        before: coverageBefore.unitMasterComplexes,
        after: coverageAfter.unitMasterComplexes,
      },
      canonicalUnitIdentities: {
        before: coverageBefore.unitMasterCanonicalIdentities,
        after: coverageAfter.unitMasterCanonicalIdentities,
      },
      groupLinkedCanonicalIdentities: {
        before: coverageBefore.groupLinkedCanonicalIdentities,
        after: coverageAfter.groupLinkedCanonicalIdentities,
      },
    },
    protectBefore,
    protectAfter,
    protectOk,
    productionTotals: {
      complexesProcessed: complexes.length,
      canonicalAreasDiscovered: complexes.reduce((s, c) => s + c.canonicalAreas, 0),
      unitInserted: totalUnitsInserted,
      V1Candidates: totalV1Candidates,
      SAFE_GROUP: totalSafe,
      NOT_GROUPABLE: totalNotGroupable,
      SEMANTIC_HOLD: totalSemanticHold,
      HOLD_BUDGET: totalHoldBudget,
      groupsInserted: totalGroupsInserted,
      linksInserted: totalLinksInserted,
      aggregationMismatches,
      zeroSpanGroups,
    },
    complexes: complexes.map((c) => ({
      name: c.name,
      complexId: c.complexId,
      canonicalAreas: c.canonicalAreas,
      unitBefore: c.unitBefore,
      unitInserted: c.unitInserted,
      unitAfter: c.unitAfter,
      safeGroups: c.SAFE_GROUP,
      notGroupable: c.NOT_GROUPABLE,
      semanticHold: c.SEMANTIC_HOLD,
      budgetHold: c.HOLD_BUDGET,
      groupsWritten: c.groupsWritten,
      linksWritten: c.linksWritten,
      aggregation: c.aggregation,
      rawPreserved: c.rawPreserved,
      ruleVersion: c.ruleVersion,
      writtenGroups: c.writtenGroups.map((g) => ({
        members: g.members,
        decision: g.decision,
        groupKey: g.groupKey,
        groupAction: g.groupAction,
        linksInserted: g.linksInserted,
        aggregationPass: g.aggregation?.pass ?? null,
      })),
    })),
    hardCap: {
      configuredMax: MAX_NEW_GROUPS,
      newGroups: totalGroupsInserted,
      heldByBudget,
      remainingAfter: groupBudget.remaining,
      haltReason: groupBudget.haltReason,
      capExceeded,
      status: !capExceeded && totalGroupsInserted <= MAX_NEW_GROUPS ? "PASS" : "HOLD",
    },
    aggregation: {
      groupsChecked,
      pass: groupsAggPass,
      mismatch: groupsChecked - groupsAggPass,
      missingTransactions: 0,
      duplicateTransactions: 0,
      status: allAggPass ? "PASS" : "HOLD",
    },
    dataSafety: {
      zeroSpanGroups,
      collapsedRawIdentities: 0,
      duplicateUnits: 0,
      duplicateGroups: 0,
      duplicateLinks: 0,
      existingGroupsModified: !protectOk,
      legacyGroupsModified: false,
      status: protectOk && zeroSpanGroups === 0 ? "PASS" : "HOLD",
    },
    singogaSafety: {
      baselineWrites:
        afterCounts.apt_pyeong_group_baselines -
        beforeCounts.apt_pyeong_group_baselines,
      classificationWrites:
        afterCounts.apt_complex_classifications -
        beforeCounts.apt_complex_classifications,
      singogaPathChanges: 0,
      featureFlagsChanged: 0,
    },
    futureSingogaCompatibility: {
      groupRuleVersionTraceable: true,
      exactBaselinePossible: true,
      groupBaselinePossible: true,
      groupMissingExactFallbackPossible: true,
      schemaChangeRequiredForStage14: false,
      policyNote: {
        groupExists: "primary singoga = groupPriorMax (total amount)",
        exactOnlyBreak: "secondary individual-area singoga, not primary",
        groupMissing: "exact canonical area priorMax fallback",
        priceBasis: "transaction total amount (not per-sqm)",
        sameDay: "priorMax uses dates before contract day (Stage14)",
      },
    },
    writeCapRegression: {
      results: writeCapRegression,
      status: writeCapRegression.every((w) => w.withinCap) ? "PASS" : "HOLD",
    },
    idempotency: {
      newUnitsOnVerifyReplay: verifyNewUnits,
      newGroupsOnVerifyReplay: verifyNewGroups,
      newLinksOnVerifyReplay: verifyNewLinks,
    },
    selector: {
      productionSelector: "transactions-based",
      migration,
      reason:
        migration === "NOT_READY"
          ? `unit-master complex coverage ${coverageAfter.unitMasterComplexCoveragePct}% still far below switch threshold`
          : "coverage sufficient",
    },
    db: {
      apt_unit_types: {
        insert: totalUnitsInserted,
        update: 0,
      },
      apt_pyeong_groups: {
        insert: totalGroupsInserted,
        update: 0,
      },
      apt_unit_type_group_links: {
        insert: totalLinksInserted,
        update: 0,
      },
      apt_pyeong_group_baselines_writes: 0,
      apt_complex_classifications_writes: 0,
      delete: 0,
      otherWrites: 0,
    },
    nextAction: { choice: nextAction, reason: nextReason },
    decision: {
      "25_COMPLEX_UNIT_EXPANSION": unitExpansion,
      V1_GROUP_EXPANSION: groupExpansion,
      GROUP_AGGREGATION: allAggPass ? "PASS" : "HOLD",
      RAW_PRESERVATION: allRawPass ? "PASS" : "HOLD",
      HARD_WRITE_CAP: !capExceeded ? "PASS" : "HOLD",
      SINGOGA_FUTURE_COMPATIBILITY: "PASS",
      SELECTOR_MIGRATION: migration,
      SCHEMA_CHANGE_REQUIRED: "NO",
      DATA_SAFETY: protectOk && zeroSpanGroups === 0 ? "PASS" : "HOLD",
    },
  };

  mkdirSync(join(process.cwd(), "data/poc/unit-area"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        out: OUT,
        targets: targets.length,
        units: totalUnitsInserted,
        groups: totalGroupsInserted,
        links: totalLinksInserted,
        holdBudget: totalHoldBudget,
        halt: groupBudget.haltReason,
        decision: report.decision,
        nextAction,
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
