/**
 * STAGE 6 — Raw unit-type production pilot (리센츠 + 트리지움 ONLY).
 *
 * Writes: apt_unit_types INSERT only (no UPDATE/DELETE).
 * Forbidden: apt_unit_type_group_links, apt_pyeong_groups, baselines,
 *            transactions, master/profile, management, source_links, schools.
 * KAPT: zero calls.
 *
 * complex_key: reuse apt_complex_master.complex_id (no slug invent).
 * unit_type_key: {complex_id}:ex{areaKey} — Stage5 provisional pattern.
 * Area precision: existing areaKey = Math.round(sqm*100)/100 (singoga.ts).
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

config({ path: ".env.local" });
config();

const OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage6-raw-unit-type-pilot.json",
);

/** Existing repo precision (src/lib/unit-type/singoga.ts). */
const areaKey = (sqm: number) => Math.round(sqm * 100) / 100;
const areaKeyStr = (sqm: number) => String(areaKey(sqm));

const TARGETS = [
  {
    name: "리센츠",
    complexId: "cx_caf229b5ac63cfbd",
    aptNameNorm: "리센츠",
    lawdCd: "11710",
    expectedAreas: [27.68, 59.99, 84.99, 98.55, 124.22],
  },
  {
    name: "트리지움",
    complexId: "cx_85cd8a4b2d5dc3d0",
    aptNameNorm: "트리지움",
    lawdCd: "11710",
    expectedAreas: [59.88, 84.83, 84.95, 84.97, 114.7, 149.45],
  },
] as const;

const PILOT_COMPLEX_KEYS = new Set([
  "acro-riverpark",
  "banpo-xi",
  "daechi-palace",
  "eunma",
  "hangang-daewoo",
  "hannam-thehill",
  "heliocity",
  "jamsil-els",
  "mokdong-7",
  "parkrio",
  "raemian-hill-godeok",
  "raemian-anyang-megatria",
]);

type Db = ReturnType<typeof createClient>;

async function tableCount(db: Db, table: string): Promise<number> {
  const r = await db.execute(`SELECT COUNT(*) c FROM ${table}`);
  return Number(r.rows[0]!.c);
}

async function loadRawAreas(
  db: Db,
  aptNameNorm: string,
  lawdCd: string,
): Promise<Array<{ exclusiveArea: number; txCount: number }>> {
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
    exclusiveArea: Number(r.ea),
    txCount: Number(r.cnt),
  }));
}

async function existingUnitsForKey(db: Db, complexKey: string) {
  const r = await db.execute({
    sql: `SELECT unit_type_key, exclusive_area_min, exclusive_area_max, supply_area_sqm, source
          FROM apt_unit_types WHERE complex_key = ?`,
    args: [complexKey],
  });
  return r.rows.map((row) => ({
    unitTypeKey: String(row.unit_type_key),
    exclusiveAreaMin: Number(row.exclusive_area_min),
    exclusiveAreaMax: Number(row.exclusive_area_max),
    supplyAreaSqm:
      row.supply_area_sqm == null ? null : Number(row.supply_area_sqm),
    source: String(row.source ?? ""),
  }));
}

async function processComplex(
  db: Db,
  t: (typeof TARGETS)[number],
) {
  const complexKey = t.complexId; // canonical Master id — not an invented slug
  const raw = await loadRawAreas(db, t.aptNameNorm, t.lawdCd);
  const before = await existingUnitsForKey(db, complexKey);

  const beforeByArea = new Map<string, (typeof before)[number]>();
  for (const u of before) {
    // Point identity: min==max under areaKey
    if (areaKey(u.exclusiveAreaMin) === areaKey(u.exclusiveAreaMax)) {
      beforeByArea.set(areaKeyStr(u.exclusiveAreaMin), u);
    }
  }

  const inserted: string[] = [];
  const skippedExisting: string[] = [];

  for (const a of raw) {
    const ak = areaKey(a.exclusiveArea);
    const aks = areaKeyStr(ak);
    const unitTypeKey = `${complexKey}:ex${aks}`;
    if (beforeByArea.has(aks)) {
      skippedExisting.push(unitTypeKey);
      continue;
    }
    // Also skip if PK already exists under any area representation
    const pk = await db.execute({
      sql: `SELECT 1 AS x FROM apt_unit_types WHERE unit_type_key = ? LIMIT 1`,
      args: [unitTypeKey],
    });
    if (pk.rows.length > 0) {
      skippedExisting.push(unitTypeKey);
      continue;
    }

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
        null, // supply unknown from transactions — schema allows NULL
        ak,
        ak,
        null,
        "transaction_raw_exclusive",
        0,
        "transactions",
      ],
    });
    inserted.push(unitTypeKey);
  }

  const after = await existingUnitsForKey(db, complexKey);
  const afterAreas = after
    .filter((u) => areaKey(u.exclusiveAreaMin) === areaKey(u.exclusiveAreaMax))
    .map((u) => areaKey(u.exclusiveAreaMin))
    .sort((a, b) => a - b);

  const rawKeys = new Set(raw.map((a) => areaKeyStr(a.exclusiveArea)));
  const afterKeys = new Set(afterAreas.map(areaKeyStr));
  const missing = [...rawKeys].filter((k) => !afterKeys.has(k));
  const unexpected = [...afterKeys].filter((k) => !rawKeys.has(k));

  // Duplicate = more than one unit type for same areaKey
  const areaCounts = new Map<string, number>();
  for (const u of after) {
    if (areaKey(u.exclusiveAreaMin) !== areaKey(u.exclusiveAreaMax)) continue;
    const k = areaKeyStr(u.exclusiveAreaMin);
    areaCounts.set(k, (areaCounts.get(k) ?? 0) + 1);
  }
  const duplicates = [...areaCounts.entries()]
    .filter(([, c]) => c > 1)
    .map(([k, c]) => ({ area: k, count: c }));

  // Collapsed = any unit spanning multiple distinct raw areas
  const collapsed = after.filter(
    (u) => areaKey(u.exclusiveAreaMin) !== areaKey(u.exclusiveAreaMax),
  );

  const expectedKeys = new Set(t.expectedAreas.map(areaKeyStr));
  const expectedMatch =
    expectedKeys.size === rawKeys.size &&
    [...expectedKeys].every((k) => rawKeys.has(k));

  const coverage =
    raw.length === 0
      ? 0
      : Math.round(((raw.length - missing.length) / raw.length) * 1000) / 10;

  return {
    complexId: t.complexId,
    complexName: t.name,
    complexKeyUsed: complexKey,
    complexKeySource: "apt_complex_master.complex_id (no slug invent)",
    rawAreas: raw.map((a) => areaKey(a.exclusiveArea)),
    rawAreaDetails: raw,
    expectedAreas: t.expectedAreas.map(areaKey),
    expectedMatch,
    beforeUnitTypes: before.length,
    inserted: inserted.length,
    insertedKeys: inserted,
    skippedExisting: skippedExisting.length,
    afterUnitTypes: after.length,
    afterAreas,
    coveragePct: coverage,
    missing,
    duplicates,
    collapsed: collapsed.map((u) => u.unitTypeKey),
    unexpected,
    selectorEquivalence:
      missing.length === 0 &&
      unexpected.length === 0 &&
      duplicates.length === 0 &&
      collapsed.length === 0
        ? "YES"
        : "NO",
    afterRows: after,
  };
}

async function triziumSimilarCheck(db: Db) {
  const members = [84.83, 84.95, 84.97];
  const span = areaKey(members[members.length - 1]! - members[0]!);
  // Comparable Phase5 production groups (Songpa neighbors + verified spans)
  const comps = await db.execute(`
    SELECT complex_key, group_key, exclusive_area_min, exclusive_area_max,
           ROUND(exclusive_area_max - exclusive_area_min, 4) AS span,
           source
    FROM apt_pyeong_groups
    WHERE complex_key IN ('parkrio','jamsil-els','raemian-hill-godeok','hangang-daewoo')
      AND exclusive_area_min BETWEEN 84 AND 86
    ORDER BY complex_key, exclusive_area_min
  `);

  // Stage5 heuristic span ≤ 0.2 is CANDIDATE only — cross-check Phase5 real spans
  const phase5ComparableSpans = comps.rows.map((r) => ({
    complexKey: String(r.complex_key),
    groupKey: String(r.group_key),
    min: Number(r.exclusive_area_min),
    max: Number(r.exclusive_area_max),
    span: Number(r.span),
    source: String(r.source),
  }));

  const maxVerifiedNear84 = Math.max(
    0,
    ...phase5ComparableSpans.map((g) => g.span),
  );

  // Distribution: each member has substantial independent tx volume
  const dist = await db.execute({
    sql: `
      SELECT exclusive_area AS ea, COUNT(*) AS cnt
      FROM transactions
      WHERE apt_name_norm = '트리지움' AND lawd_cd = '11710'
        AND exclusive_area IN (84.83, 84.95, 84.97)
      GROUP BY exclusive_area
      ORDER BY exclusive_area
    `,
  });

  const decision =
    span <= 0.2 &&
    span <= maxVerifiedNear84 + 0.001 &&
    phase5ComparableSpans.some((g) => g.span >= span - 0.001)
      ? "SAFE_GROUP_CANDIDATE"
      : span <= 0.2
        ? "AMBIGUOUS"
        : "NOT_GROUPABLE";

  return {
    members,
    span,
    stage5HeuristicSpanMax: 0.2,
    phase5ComparableSpans,
    txDistribution: dist.rows.map((r) => ({
      exclusiveArea: Number(r.ea),
      txCount: Number(r.cnt),
    })),
    decision,
    reason:
      decision === "SAFE_GROUP_CANDIDATE"
        ? `Span ${span}㎡ ≤ 0.2 and within Phase5 verified Songpa 84㎡ group spans (e.g. parkrio 84.79–84.97, jamsil-els 84.80–84.97). Raw identities must still survive. NO production group write this stage.`
        : decision === "AMBIGUOUS"
          ? `Span ${span}㎡ passes Stage5 ≤0.2 heuristic but Phase5 comparable evidence is weak.`
          : `Span ${span}㎡ exceeds grouping tolerance.`,
    dbWrites: 0,
  };
}

async function nextPilotCandidates(db: Db) {
  // Songpa IDENTITY-READY with diverse raw areas, excluding current targets + existing unit pilots
  const masters = await db.execute(`
    SELECT complex_id, apt_name_norm, lawd_cd, legal_dong_name
    FROM apt_complex_master
    WHERE identity_status = 'IDENTITY-READY'
      AND lawd_cd = '11710'
      AND complex_id NOT IN ('cx_caf229b5ac63cfbd','cx_85cd8a4b2d5dc3d0')
  `);

  const mapped = await db.execute(`
    SELECT DISTINCT complex_id, complex_key FROM apt_pyeong_groups
    WHERE complex_id IS NOT NULL
  `);
  const idToPilotKey = new Map(
    mapped.rows.map((r) => [String(r.complex_id), String(r.complex_key)]),
  );

  const scored: Array<{
    complexId: string;
    name: string;
    lawdCd: string;
    dong: string | null;
    rawAreaCount: number;
    rawAreas: number[];
    hasExistingUnitPilot: boolean;
    existingComplexKey: string | null;
    scoreNote: string;
  }> = [];

  for (const m of masters.rows) {
    const cid = String(m.complex_id);
    const name = String(m.apt_name_norm);
    const lawd = String(m.lawd_cd);
    const areas = await loadRawAreas(db, name, lawd);
    if (areas.length < 3 || areas.length > 12) continue;
    const existingKey = idToPilotKey.get(cid) ?? null;
    const hasPilot = existingKey != null && PILOT_COMPLEX_KEYS.has(existingKey);
    // Prefer non-pilot for expansion, but allow nearby pilots for comparison listing
    const has84cluster =
      areas.filter((a) => a.exclusiveArea >= 84 && a.exclusiveArea <= 86)
        .length >= 2;
    scored.push({
      complexId: cid,
      name,
      lawdCd: lawd,
      dong: m.legal_dong_name != null ? String(m.legal_dong_name) : null,
      rawAreaCount: areas.length,
      rawAreas: areas.map((a) => areaKey(a.exclusiveArea)),
      hasExistingUnitPilot: hasPilot,
      existingComplexKey: existingKey,
      scoreNote: hasPilot
        ? "existing Phase5 group pilot — compare only"
        : has84cluster
          ? "diverse raw + near-84 cluster (리센츠/트리지움-like)"
          : "diverse raw areas, no unit pilot yet",
    });
  }

  scored.sort((a, b) => {
    // Prefer non-pilot first, then similar area count to current pilots (5–8), then 84-cluster
    const ap = a.hasExistingUnitPilot ? 1 : 0;
    const bp = b.hasExistingUnitPilot ? 1 : 0;
    if (ap !== bp) return ap - bp;
    const aIdeal = Math.abs(a.rawAreaCount - 6);
    const bIdeal = Math.abs(b.rawAreaCount - 6);
    if (aIdeal !== bIdeal) return aIdeal - bIdeal;
    return b.rawAreaCount - a.rawAreaCount;
  });

  return scored.slice(0, 8);
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });

  const beforeCounts = {
    apt_unit_types: await tableCount(db, "apt_unit_types"),
    apt_unit_type_group_links: await tableCount(db, "apt_unit_type_group_links"),
    apt_pyeong_groups: await tableCount(db, "apt_pyeong_groups"),
    apt_pyeong_group_baselines: await tableCount(
      db,
      "apt_pyeong_group_baselines",
    ),
  };

  // Contract snapshot for existing pilots (must not change)
  const pilotSnapshots: Record<string, number> = {};
  for (const ck of PILOT_COMPLEX_KEYS) {
    const r = await db.execute({
      sql: `SELECT COUNT(*) c FROM apt_unit_types WHERE complex_key = ?`,
      args: [ck],
    });
    pilotSnapshots[ck] = Number(r.rows[0]!.c);
  }

  // Classification presence → singoga coupling gate
  const classHits = await db.execute(`
    SELECT apt_name_norm, complex_key FROM apt_complex_classifications
    WHERE apt_name_norm IN ('리센츠','트리지움')
  `);

  const results = [];
  for (const t of TARGETS) {
    results.push(await processComplex(db, t));
  }

  const afterCounts = {
    apt_unit_types: await tableCount(db, "apt_unit_types"),
    apt_unit_type_group_links: await tableCount(db, "apt_unit_type_group_links"),
    apt_pyeong_groups: await tableCount(db, "apt_pyeong_groups"),
    apt_pyeong_group_baselines: await tableCount(
      db,
      "apt_pyeong_group_baselines",
    ),
  };

  const pilotSnapshotsAfter: Record<string, number> = {};
  for (const ck of PILOT_COMPLEX_KEYS) {
    const r = await db.execute({
      sql: `SELECT COUNT(*) c FROM apt_unit_types WHERE complex_key = ?`,
      args: [ck],
    });
    pilotSnapshotsAfter[ck] = Number(r.rows[0]!.c);
  }
  const pilotUnchanged = Object.keys(pilotSnapshots).every(
    (k) => pilotSnapshots[k] === pilotSnapshotsAfter[k],
  );

  const trizium84 = await triziumSimilarCheck(db);
  const nextCandidates = await nextPilotCandidates(db);

  const ricenz = results.find((r) => r.complexName === "리센츠")!;
  const trizium = results.find((r) => r.complexName === "트리지움")!;

  const insertTotal = results.reduce((s, r) => s + r.inserted, 0);
  const allPass =
    ricenz.coveragePct === 100 &&
    trizium.coveragePct === 100 &&
    ricenz.duplicates.length === 0 &&
    trizium.duplicates.length === 0 &&
    ricenz.missing.length === 0 &&
    trizium.missing.length === 0 &&
    ricenz.collapsed.length === 0 &&
    trizium.collapsed.length === 0 &&
    ricenz.unexpected.length === 0 &&
    trizium.unexpected.length === 0 &&
    afterCounts.apt_unit_type_group_links ===
      beforeCounts.apt_unit_type_group_links &&
    afterCounts.apt_pyeong_groups === beforeCounts.apt_pyeong_groups &&
    afterCounts.apt_pyeong_group_baselines ===
      beforeCounts.apt_pyeong_group_baselines &&
    pilotUnchanged &&
    classHits.rows.length === 0;

  const artifact = {
    generatedAt: new Date().toISOString(),
    stage: "stage6-raw-unit-type-pilot",
    scope: "리센츠 + 트리지움 only",
    contract: {
      uniqueIdentity: "unit_type_key PRIMARY KEY",
      complexIdSupportOnTable: false,
      legacyComplexKeyRequired: true,
      complexKeyStrategy:
        "reuse apt_complex_master.complex_id as complex_key (no slug invent; no pyeong_groups mapping existed)",
      areaPrecisionRule: "areaKey = Math.round(sqm*100)/100 (singoga.ts)",
      existingHelperReused:
        "direct INSERT matching repository.ts column contract; replacePilotMasterBundles NOT used (would delete/replace groups)",
      supplyArea: "NULL (transactions have exclusive only)",
      source: "transactions",
      mappingConfidence: "transaction_raw_exclusive",
    },
    beforeCounts,
    afterCounts,
    pilotSnapshots,
    pilotSnapshotsAfter,
    pilotUnchanged,
    classificationRowsForTargets: classHits.rows,
    complexes: results,
    trizium84Candidate: trizium84,
    nextPilotCandidates: nextCandidates,
    downstreamSafety: {
      groupLinksChanged:
        afterCounts.apt_unit_type_group_links !==
        beforeCounts.apt_unit_type_group_links,
      pyeongGroupsChanged:
        afterCounts.apt_pyeong_groups !== beforeCounts.apt_pyeong_groups,
      baselinesChanged:
        afterCounts.apt_pyeong_group_baselines !==
        beforeCounts.apt_pyeong_group_baselines,
      singogaBehaviorChanged: false,
      singogaNote:
        "loadUnitTypeMasterByAptName requires apt_complex_classifications; none for 리센츠/트리지움 → exclusive all-time-max path unchanged",
      existingPilotDataChanged: !pilotUnchanged,
    },
    db: {
      apt_unit_types_insert: insertTotal,
      apt_unit_types_update: 0,
      apt_unit_types_delete: 0,
      other_table_writes: 0,
      kapt_api_calls: 0,
    },
    decision: {
      RAW_UNIT_TYPE_PRODUCTION_PILOT: allPass ? "PASS" : "PARTIAL",
      RAW_AREA_PRESERVATION:
        trizium.afterAreas.includes(84.83) &&
        trizium.afterAreas.includes(84.95) &&
        trizium.afterAreas.includes(84.97) &&
        ricenz.collapsed.length === 0 &&
        trizium.collapsed.length === 0
          ? "PASS"
          : "HOLD",
      SELECTOR_UNIT_TYPE_READINESS:
        ricenz.selectorEquivalence === "YES" &&
        trizium.selectorEquivalence === "YES"
          ? "PASS"
          : "HOLD",
      TRIZIUM_SIMILAR_GROUP: trizium84.decision,
      SCHEMA_CHANGE_REQUIRED: "NO",
      DATA_SAFETY: allPass ? "PASS" : "HOLD",
    },
  };

  mkdirSync(join(process.cwd(), "data/poc/unit-area"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify(artifact, null, 2));
  console.log("\nWrote", OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
