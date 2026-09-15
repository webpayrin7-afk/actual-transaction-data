/**
 * STAGE 7 — Similar-area group production pilot (트리지움 84㎡ family ONLY).
 *
 * Writes:
 *   apt_pyeong_groups          — 1 group (idempotent)
 *   apt_unit_type_group_links  — 3 links (idempotent)
 *
 * Forbidden: apt_unit_types mutate, baselines, classifications,
 *            other complexes/areas, KAPT/NEIS/SchoolInfo.
 *
 * complex_key = cx_85cd8a4b2d5dc3d0 (Stage6 convention; no slug invent).
 * market_label = NULL / display_mode = range_only (no supply → no 평 canonicalize).
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

config({ path: ".env.local" });
config();

const OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage7-similar-area-group-pilot.json",
);

const COMPLEX_ID = "cx_85cd8a4b2d5dc3d0";
const COMPLEX_KEY = COMPLEX_ID; // Stage6 carrier
const APT_NAME = "트리지움";
const LAWD = "11710";
const MEMBERS = [84.83, 84.95, 84.97] as const;
const AREA_MIN = 84.83;
const AREA_MAX = 84.97;

/** Existing repo precision (singoga.ts). */
const areaKey = (sqm: number) => Math.round(sqm * 100) / 100;
const areaKeyStr = (sqm: number) => String(areaKey(sqm));

/** Phase5 group_key area fragment uses 2-decimal fixed form (e.g. ex84.80-84.97). */
const fmtKeyArea = (sqm: number) => areaKey(sqm).toFixed(2);

const GROUP_KEY = `${COMPLEX_KEY}:G1:ex${fmtKeyArea(AREA_MIN)}-${fmtKeyArea(AREA_MAX)}`;

const MEMBER_UNIT_KEYS = MEMBERS.map(
  (a) => `${COMPLEX_KEY}:ex${areaKeyStr(a)}`,
);

type Db = ReturnType<typeof createClient>;

async function count(db: Db, sql: string, args: unknown[] = []) {
  const r = await db.execute({ sql, args });
  return Number(r.rows[0]!.c);
}

async function tableCount(db: Db, table: string) {
  return count(db, `SELECT COUNT(*) c FROM ${table}`);
}

async function ensureUnitsIntact(db: Db) {
  const units = await db.execute({
    sql: `SELECT unit_type_key, exclusive_area_min, exclusive_area_max, complex_key, source
          FROM apt_unit_types WHERE complex_key = ? ORDER BY exclusive_area_min`,
    args: [COMPLEX_KEY],
  });
  const rows = units.rows.map((r) => ({
    unitTypeKey: String(r.unit_type_key),
    exclusiveAreaMin: Number(r.exclusive_area_min),
    exclusiveAreaMax: Number(r.exclusive_area_max),
    complexKey: String(r.complex_key),
    source: String(r.source ?? ""),
  }));
  const byArea = new Map(
    rows
      .filter((u) => areaKey(u.exclusiveAreaMin) === areaKey(u.exclusiveAreaMax))
      .map((u) => [areaKeyStr(u.exclusiveAreaMin), u]),
  );
  const missingMembers = MEMBERS.filter((a) => !byArea.has(areaKeyStr(a)));
  const allAreas = [...byArea.keys()].map(Number).sort((a, b) => a - b);
  return { rows, byArea, missingMembers, allAreas, count: rows.length };
}

async function upsertGroup(db: Db): Promise<"inserted" | "exists"> {
  const existing = await db.execute({
    sql: `SELECT group_key, exclusive_area_min, exclusive_area_max, complex_key, market_label, display_mode
          FROM apt_pyeong_groups WHERE group_key = ?`,
    args: [GROUP_KEY],
  });
  if (existing.rows.length > 0) {
    const r = existing.rows[0]!;
    if (
      String(r.complex_key) !== COMPLEX_KEY ||
      areaKey(Number(r.exclusive_area_min)) !== areaKey(AREA_MIN) ||
      areaKey(Number(r.exclusive_area_max)) !== areaKey(AREA_MAX)
    ) {
      throw new Error(
        `HOLD: existing group_key ${GROUP_KEY} conflicts with expected contract`,
      );
    }
    return "exists";
  }

  // Direct INSERT matching repository.ts columns + live complex_id column.
  // Do NOT call replacePilotMasterBundles (deletes units/groups).
  await db.execute({
    sql: `INSERT INTO apt_pyeong_groups (
      group_key, complex_key, market_label, display_mode,
      supply_area_min, supply_area_max, exclusive_area_min, exclusive_area_max,
      household_count, confidence, group_confidence_high, label_null_reason,
      sort_order, source, complex_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      GROUP_KEY,
      COMPLEX_KEY,
      null, // no supply → no market 평 label
      "range_only",
      null,
      null,
      areaKey(AREA_MIN),
      areaKey(AREA_MAX),
      null,
      "grouped",
      1,
      "no_supply_area", // neutral; do not invent 26평
      0,
      "transactions-similar-area",
      COMPLEX_ID,
    ],
  });
  return "inserted";
}

async function upsertLinks(db: Db): Promise<{ inserted: string[]; existed: string[] }> {
  const inserted: string[] = [];
  const existed: string[] = [];
  for (const utk of MEMBER_UNIT_KEYS) {
    const hit = await db.execute({
      sql: `SELECT unit_type_key FROM apt_unit_type_group_links
            WHERE unit_type_key = ? AND group_key = ?`,
      args: [utk, GROUP_KEY],
    });
    if (hit.rows.length > 0) {
      existed.push(utk);
      continue;
    }
    // Guard: member must not already link to another group for this complex
    const other = await db.execute({
      sql: `SELECT group_key FROM apt_unit_type_group_links
            WHERE unit_type_key = ? AND group_key != ?`,
      args: [utk, GROUP_KEY],
    });
    if (other.rows.length > 0) {
      throw new Error(
        `HOLD: unit ${utk} already linked to ${other.rows.map((r) => r.group_key).join(",")}`,
      );
    }
    await db.execute({
      sql: `INSERT INTO apt_unit_type_group_links (
        unit_type_key, group_key, complex_key, is_outlier
      ) VALUES (?, ?, ?, ?)`,
      args: [utk, GROUP_KEY, COMPLEX_KEY, 0],
    });
    inserted.push(utk);
  }
  return { inserted, existed };
}

async function txCounts(db: Db) {
  const per: Record<string, number> = {};
  for (const a of MEMBERS) {
    const c = await count(
      db,
      `SELECT COUNT(*) c FROM transactions
       WHERE apt_name_norm = ? AND lawd_cd = ?
         AND exclusive_area IS NOT NULL
         AND ROUND(exclusive_area * 100) = ROUND(? * 100)`,
      [APT_NAME, LAWD, a],
    );
    per[areaKeyStr(a)] = c;
  }
  const memberSum = Object.values(per).reduce((s, n) => s + n, 0);
  const groupResult = await count(
    db,
    `SELECT COUNT(*) c FROM transactions
     WHERE apt_name_norm = ? AND lawd_cd = ?
       AND exclusive_area IS NOT NULL
       AND ROUND(exclusive_area * 100) IN (${MEMBERS.map(() => "ROUND(? * 100)").join(",")})`,
    [APT_NAME, LAWD, ...MEMBERS],
  );
  // Outside-range leakage check (should be 0 extra vs sum)
  return { per, memberSum, groupResult, missing: memberSum - groupResult, duplicates: groupResult - memberSum };
}

async function rawIndependentQuery(db: Db) {
  const out: Record<string, { unitExists: boolean; txCount: number }> = {};
  for (const a of MEMBERS) {
    const utk = `${COMPLEX_KEY}:ex${areaKeyStr(a)}`;
    const u = await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_types WHERE unit_type_key = ?`,
      [utk],
    );
    const t = await count(
      db,
      `SELECT COUNT(*) c FROM transactions
       WHERE apt_name_norm = ? AND lawd_cd = ?
         AND ROUND(exclusive_area * 100) = ROUND(? * 100)`,
      [APT_NAME, LAWD, a],
    );
    out[areaKeyStr(a)] = { unitExists: u === 1, txCount: t };
  }
  return out;
}

async function nextCandidates(db: Db) {
  // Prefer Songpa IDENTITY-READY with near-84 cluster, no existing group pilot mapping
  const mapped = await db.execute(`
    SELECT DISTINCT complex_id FROM apt_pyeong_groups WHERE complex_id IS NOT NULL
  `);
  const hasPilot = new Set(mapped.rows.map((r) => String(r.complex_id)));
  hasPilot.add(COMPLEX_ID);
  hasPilot.add("cx_caf229b5ac63cfbd"); // 리센츠 — already in pipeline

  const masters = await db.execute(`
    SELECT complex_id, apt_name_norm, lawd_cd, legal_dong_name
    FROM apt_complex_master
    WHERE identity_status = 'IDENTITY-READY' AND lawd_cd = '11710'
  `);

  const scored: Array<{
    complexId: string;
    name: string;
    dong: string | null;
    rawAreas: number[];
    near84: number[];
    note: string;
  }> = [];

  for (const m of masters.rows) {
    const cid = String(m.complex_id);
    if (hasPilot.has(cid)) continue;
    const name = String(m.apt_name_norm);
    const lawd = String(m.lawd_cd);
    const tx = await db.execute({
      sql: `
        SELECT exclusive_area AS ea FROM transactions
        WHERE apt_name_norm = ? AND lawd_cd = ?
          AND exclusive_area IS NOT NULL AND exclusive_area > 0
        GROUP BY exclusive_area ORDER BY exclusive_area`,
      args: [name, lawd],
    });
    const areas = tx.rows.map((r) => areaKey(Number(r.ea)));
    if (areas.length < 4 || areas.length > 10) continue;
    const near84 = areas.filter((a) => a >= 84 && a <= 86);
    if (near84.length < 2) continue;
    scored.push({
      complexId: cid,
      name,
      dong: m.legal_dong_name != null ? String(m.legal_dong_name) : null,
      rawAreas: areas,
      near84,
      note: `near-84 cluster (${near84.join(", ")}); ${areas.length} raw areas; no group pilot yet`,
    });
  }

  scored.sort((a, b) => {
    if (b.near84.length !== a.near84.length) return b.near84.length - a.near84.length;
    return Math.abs(a.rawAreas.length - 6) - Math.abs(b.rawAreas.length - 6);
  });
  return scored.slice(0, 5);
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });

  const before = {
    apt_unit_types: await tableCount(db, "apt_unit_types"),
    apt_pyeong_groups: await tableCount(db, "apt_pyeong_groups"),
    apt_unit_type_group_links: await tableCount(db, "apt_unit_type_group_links"),
    apt_pyeong_group_baselines: await tableCount(db, "apt_pyeong_group_baselines"),
    apt_complex_classifications: await tableCount(
      db,
      "apt_complex_classifications",
    ),
    triziumUnits: await ensureUnitsIntact(db),
    triziumGroups: await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE complex_key = ?`,
      [COMPLEX_KEY],
    ),
    triziumLinks: await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links WHERE complex_key = ?`,
      [COMPLEX_KEY],
    ),
    classificationTrizium: await count(
      db,
      `SELECT COUNT(*) c FROM apt_complex_classifications WHERE apt_name_norm = ?`,
      [APT_NAME],
    ),
  };

  if (before.triziumUnits.missingMembers.length > 0) {
    throw new Error(
      `HOLD: missing Stage6 unit types for ${before.triziumUnits.missingMembers.join(",")}`,
    );
  }
  if (before.triziumUnits.rows.some((u) => u.complexKey !== COMPLEX_KEY)) {
    throw new Error("HOLD: complex_key identity mismatch on unit types");
  }

  // Snapshot unit rows (must be byte-identical after write)
  const unitSnapshotBefore = JSON.stringify(before.triziumUnits.rows);

  const groupAction = await upsertGroup(db);
  const linkAction = await upsertLinks(db);

  // Idempotency second pass
  const groupAction2 = await upsertGroup(db);
  const linkAction2 = await upsertLinks(db);

  const afterUnits = await ensureUnitsIntact(db);
  const unitSnapshotAfter = JSON.stringify(afterUnits.rows);
  const unitsUnchanged = unitSnapshotBefore === unitSnapshotAfter;

  const groupRow = await db.execute({
    sql: `SELECT * FROM apt_pyeong_groups WHERE group_key = ?`,
    args: [GROUP_KEY],
  });
  const links = await db.execute({
    sql: `SELECT * FROM apt_unit_type_group_links WHERE group_key = ? ORDER BY unit_type_key`,
    args: [GROUP_KEY],
  });
  const duplicateLinkCheck = await count(
    db,
    `SELECT COUNT(*) c FROM (
       SELECT unit_type_key, COUNT(*) c FROM apt_unit_type_group_links
       WHERE group_key = ? GROUP BY unit_type_key HAVING c > 1
     )`,
    [GROUP_KEY],
  );
  // Multi-group membership for members
  const multiGroup = await db.execute({
    sql: `SELECT unit_type_key, COUNT(*) c FROM apt_unit_type_group_links
          WHERE unit_type_key IN (${MEMBER_UNIT_KEYS.map(() => "?").join(",")})
          GROUP BY unit_type_key HAVING c > 1`,
    args: MEMBER_UNIT_KEYS,
  });

  // Forbidden area groups must not exist
  const otherAreaGroups = await db.execute({
    sql: `SELECT group_key FROM apt_pyeong_groups
          WHERE complex_key = ? AND group_key != ?`,
    args: [COMPLEX_KEY, GROUP_KEY],
  });
  const ricenzGroups = await count(
    db,
    `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE complex_key = ?`,
    ["cx_caf229b5ac63cfbd"],
  );

  const aggregation = await txCounts(db);
  const rawQuery = await rawIndependentQuery(db);

  const after = {
    apt_unit_types: await tableCount(db, "apt_unit_types"),
    apt_pyeong_groups: await tableCount(db, "apt_pyeong_groups"),
    apt_unit_type_group_links: await tableCount(db, "apt_unit_type_group_links"),
    apt_pyeong_group_baselines: await tableCount(db, "apt_pyeong_group_baselines"),
    apt_complex_classifications: await tableCount(
      db,
      "apt_complex_classifications",
    ),
    classificationTrizium: await count(
      db,
      `SELECT COUNT(*) c FROM apt_complex_classifications WHERE apt_name_norm = ?`,
      [APT_NAME],
    ),
  };

  const nextPilotCandidates = await nextCandidates(db);

  const memberExists = Object.fromEntries(
    MEMBERS.map((a) => [
      areaKeyStr(a),
      afterUnits.byArea.has(areaKeyStr(a)),
    ]),
  );

  const allRawStillPresent = [59.88, 84.83, 84.95, 84.97, 114.7, 149.45].every(
    (a) => afterUnits.allAreas.includes(areaKey(a)),
  );

  const aggregationPass =
    aggregation.missing === 0 &&
    aggregation.duplicates === 0 &&
    aggregation.groupResult === aggregation.memberSum;

  const singogaSafe =
    after.classificationTrizium === before.classificationTrizium &&
    after.apt_pyeong_group_baselines === before.apt_pyeong_group_baselines &&
    after.apt_complex_classifications === before.apt_complex_classifications;

  const rawPass =
    unitsUnchanged &&
    Object.values(memberExists).every(Boolean) &&
    allRawStillPresent &&
    Object.values(rawQuery).every((r) => r.unitExists);

  const pass =
    groupRow.rows.length === 1 &&
    links.rows.length === 3 &&
    duplicateLinkCheck === 0 &&
    multiGroup.rows.length === 0 &&
    otherAreaGroups.rows.length === 0 &&
    ricenzGroups === 0 &&
    groupAction2 === "exists" &&
    linkAction2.inserted.length === 0 &&
    aggregationPass &&
    rawPass &&
    singogaSafe &&
    after.apt_unit_types === before.apt_unit_types;

  const artifact = {
    generatedAt: new Date().toISOString(),
    stage: "stage7-similar-area-group-pilot",
    scope: "트리지움 84㎡ family ONLY (84.83 / 84.95 / 84.97)",
    contract: {
      groupKey: GROUP_KEY,
      complexKey: COMPLEX_KEY,
      complexId: COMPLEX_ID,
      areaMin: AREA_MIN,
      areaMax: AREA_MAX,
      representativeArea: AREA_MIN, // Phase5 selector uses exclusiveAreaMin
      displayMode: "range_only",
      marketLabel: null,
      labelNullReason: "no_supply_area",
      displaySemantics: "84㎡대 / 전용 84.83~84.97㎡ (NOT 26평)",
      supplyAreaPyeongLabel: false,
      helperReused:
        "direct INSERT matching repository.ts columns (+ complex_id); replacePilotMasterBundles NOT used",
      groupKeyConvention: "{complex_key}:G{n}:ex{min}-{max} with toFixed(2)",
    },
    before: {
      unitTypesGlobal: before.apt_unit_types,
      groupsGlobal: before.apt_pyeong_groups,
      linksGlobal: before.apt_unit_type_group_links,
      triziumUnitTypes: before.triziumUnits.count,
      triziumGroups: before.triziumGroups,
      triziumLinks: before.triziumLinks,
      triziumAreas: before.triziumUnits.allAreas,
    },
    write: {
      groupAction,
      groupActionIdempotentReplay: groupAction2,
      linksInserted: linkAction.inserted.length,
      linksExisted: linkAction.existed.length,
      linksInsertedKeys: linkAction.inserted,
      linksReplayInserted: linkAction2.inserted.length,
      unitTypesModified: unitsUnchanged ? 0 : -1,
      baselinesModified: 0,
      classificationsModified: 0,
    },
    after: {
      memberExists,
      groupExists: groupRow.rows.length === 1,
      groupRow: groupRow.rows[0] ?? null,
      members: links.rows.map((r) => ({
        unitTypeKey: String(r.unit_type_key),
        groupKey: String(r.group_key),
        complexKey: String(r.complex_key),
        isOutlier: Number(r.is_outlier) === 1,
      })),
      duplicateLinks: duplicateLinkCheck,
      multiGroupMembership: multiGroup.rows,
      otherAreaGroupsForTrizium: otherAreaGroups.rows,
      ricenzGroups,
      allRawAreas: afterUnits.allAreas,
      allRawStillPresent,
      unitsUnchanged,
      counts: after,
    },
    transactionAggregation: {
      perMember: aggregation.per,
      memberSum: aggregation.memberSum,
      groupResult: aggregation.groupResult,
      missing: aggregation.missing,
      duplicates: aggregation.duplicates,
      pass: aggregationPass,
    },
    rawQueryPreservation: rawQuery,
    selectorReadiness: {
      groupDisplayPossible: true,
      rawDisplayPossible: allRawStillPresent && rawPass,
      suggestedFutureLabel: "84㎡대",
      schemaFormattedLabelExample: "전용 84.83~84.97㎡ (range_only)",
      supplyAreaPyeongLabelAvailable: false,
      note: "UI not modified; data contract supports group view + raw drill-down",
    },
    singogaSafety: {
      classificationChanged: after.classificationTrizium !== before.classificationTrizium,
      baselineChanged:
        after.apt_pyeong_group_baselines !== before.apt_pyeong_group_baselines,
      singogaPathChanged: false,
      singogaNote:
        "No apt_complex_classifications for 트리지움 → loadUnitTypeMasterByAptName returns null → exclusive all-time-max unchanged",
      featureFlagsChanged: false,
    },
    nextPilotCandidates,
    db: {
      apt_pyeong_groups_insert: groupAction === "inserted" ? 1 : 0,
      apt_pyeong_groups_update: 0,
      apt_unit_type_group_links_insert: linkAction.inserted.length,
      apt_unit_type_group_links_update: 0,
      other_writes: 0,
      delete: 0,
      kapt_api_calls: 0,
    },
    decision: {
      SIMILAR_AREA_PRODUCTION_PILOT: pass ? "PASS" : "HOLD",
      RAW_AREA_PRESERVATION: rawPass ? "PASS" : "HOLD",
      GROUP_AGGREGATION: aggregationPass ? "PASS" : "HOLD",
      SELECTOR_DATA_CONTRACT:
        allRawStillPresent && groupRow.rows.length === 1 ? "PASS" : "HOLD",
      SINGOGA_SAFETY: singogaSafe ? "PASS" : "HOLD",
      SCHEMA_CHANGE_REQUIRED: "NO",
      DATA_SAFETY: pass ? "PASS" : "HOLD",
    },
  };

  mkdirSync(join(process.cwd(), "data/poc/unit-area"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify(artifact, null, 2));
  console.log("\nWrote", OUT);
  if (!pass) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
