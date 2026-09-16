/**
 * STAGE 22 — 100-complex unit-master acceleration (manifest-gated Production).
 *
 * Writes: apt_unit_types INSERT only (manifest targets, cx_ keys, missing rows).
 * Forbidden: groups, links, baselines, classifications, UPDATE/DELETE, slug keys,
 *            transactions/master mutation, external APIs, singoga.
 */
import { createClient, type InArgs } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  areaKey,
  areaKeyStr,
  clusterByCommonRuleV1,
  dedupeAreas,
  type AreaRow,
} from "./lib/stage9-grouping-contract";

config({ path: ".env.local" });
config();

const MANIFEST_OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage22-unit-promotion-manifest.json",
);
const REPORT_OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage22-unit-expansion.json",
);

const TARGET_COUNT = 100;
const MIN_TRADE_TX = 50;
const MIN_AREAS = 2;
const MAX_AREAS = 20;
const MAX_NEW_UNIT_ROWS = 1500;
const RULE_VERSION = "transaction_raw_exclusive_v1";

const OFFICIAL_RAW_SQL = `
SELECT m.complex_id AS complex_id,
       ROUND(t.exclusive_area * 100) / 100 AS ak
FROM transactions t
JOIN apt_complex_master m
  ON m.apt_name_norm = t.apt_name_norm AND m.lawd_cd = t.lawd_cd
WHERE t.deal_type = 'trade'
  AND t.exclusive_area IS NOT NULL
  AND t.exclusive_area > 0
  AND m.sido_code = '11'
  AND m.identity_status = 'IDENTITY-READY'
GROUP BY m.complex_id, ROUND(t.exclusive_area * 100) / 100
`;

type Db = ReturnType<typeof createClient>;

type Target = {
  complexId: string;
  aptNameNorm: string;
  lawdCd: string;
  aptName: string | null;
  tradeTxCount: number;
  canonicalAreaCount: number;
  areas: AreaRow[];
};

type Hold = { complexId: string; reason: string };

async function count(db: Db, sql: string, args: InArgs = []) {
  const r = await db.execute({ sql, args });
  return Number(r.rows[0]!.c);
}

async function tableCount(db: Db, table: string) {
  return count(db, `SELECT COUNT(*) c FROM ${table}`);
}

async function coverageSnapshot(db: Db) {
  const seoulComplexes = await count(
    db,
    `SELECT COUNT(*) c FROM apt_complex_master
     WHERE sido_code='11' AND identity_status='IDENTITY-READY'`,
  );
  const unitMasterComplexes = await count(
    db,
    `SELECT COUNT(DISTINCT complex_key) c FROM apt_unit_types WHERE complex_key LIKE 'cx_%'`,
  );
  const canonicalRaw = await count(
    db,
    `SELECT COUNT(*) c FROM (${OFFICIAL_RAW_SQL})`,
  );
  const unitMasterCanonical = await count(
    db,
    `SELECT COUNT(*) c FROM (
       SELECT complex_key, ROUND(exclusive_area_min*100)/100
       FROM apt_unit_types WHERE complex_key LIKE 'cx_%'
       GROUP BY complex_key, ROUND(exclusive_area_min*100)/100
     )`,
  );
  const pct = (n: number, d: number) =>
    d === 0 ? 0 : Math.round((n / d) * 10000) / 100;
  return {
    seoulComplexes,
    unitMasterComplexes,
    unitMasterComplexCoveragePct: pct(unitMasterComplexes, seoulComplexes),
    canonicalRawTradeIdentities: canonicalRaw,
    unitMasterCanonicalIdentities: unitMasterCanonical,
    unitAreaCoveragePct: pct(unitMasterCanonical, canonicalRaw),
  };
}

async function tableExists(db: Db, name: string) {
  return (
    (await count(
      db,
      `SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?`,
      [name],
    )) > 0
  );
}

async function safetySnapshot(db: Db) {
  const hasLinks = await tableExists(db, "apt_complex_source_links");
  const hasBaselines = await tableExists(db, "apt_pyeong_group_baselines");
  const hasClass = await tableExists(db, "apt_complex_classifications");
  return {
    transactions: await tableCount(db, "transactions"),
    apt_complex_master: await tableCount(db, "apt_complex_master"),
    apt_complex_source_links: hasLinks
      ? await tableCount(db, "apt_complex_source_links")
      : -1,
    apt_unit_types: await tableCount(db, "apt_unit_types"),
    apt_unit_types_legacy: await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_types WHERE complex_key NOT LIKE 'cx_%'`,
    ),
    apt_pyeong_groups: await tableCount(db, "apt_pyeong_groups"),
    apt_unit_type_group_links: await tableCount(db, "apt_unit_type_group_links"),
    apt_pyeong_group_baselines: hasBaselines
      ? await tableCount(db, "apt_pyeong_group_baselines")
      : -1,
    apt_complex_classifications: hasClass
      ? await tableCount(db, "apt_complex_classifications")
      : -1,
  };
}

async function loadTradeAreas(
  db: Db,
  aptNameNorm: string,
  lawdCd: string,
): Promise<AreaRow[]> {
  const tx = await db.execute({
    sql: `
      SELECT exclusive_area AS ea, COUNT(*) AS cnt
      FROM transactions
      WHERE apt_name_norm = ? AND lawd_cd = ?
        AND deal_type = 'trade'
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

async function selectTargets(db: Db): Promise<{
  targets: Target[];
  poolSize: number;
  existingUnitMasterExcluded: number;
  selectionMs: number;
}> {
  const t0 = Date.now();
  const have = await db.execute(
    `SELECT DISTINCT complex_key FROM apt_unit_types WHERE complex_key LIKE 'cx_%'`,
  );
  const exclude = new Set(have.rows.map((r) => String(r.complex_key)));
  const existingUnitMasterExcluded = exclude.size;

  // Aggregate trade inventory for Seoul IDENTITY-READY, excluding existing cx_ masters.
  const inv = await db.execute(`
    SELECT m.complex_id, m.apt_name_norm, m.lawd_cd, m.apt_name,
           COUNT(*) AS trade_tx,
           COUNT(DISTINCT ROUND(t.exclusive_area * 100) / 100) AS area_n
    FROM apt_complex_master m
    JOIN transactions t
      ON t.apt_name_norm = m.apt_name_norm AND t.lawd_cd = m.lawd_cd
    WHERE m.identity_status = 'IDENTITY-READY'
      AND m.sido_code = '11'
      AND m.complex_id LIKE 'cx_%'
      AND t.deal_type = 'trade'
      AND t.exclusive_area IS NOT NULL
      AND t.exclusive_area > 0
    GROUP BY m.complex_id, m.apt_name_norm, m.lawd_cd, m.apt_name
    HAVING COUNT(*) >= ${MIN_TRADE_TX}
       AND COUNT(DISTINCT ROUND(t.exclusive_area * 100) / 100) >= ${MIN_AREAS}
       AND COUNT(DISTINCT ROUND(t.exclusive_area * 100) / 100) <= ${MAX_AREAS}
    ORDER BY COUNT(*) DESC, m.complex_id ASC
  `);

  const eligibleMeta: Array<{
    complexId: string;
    aptNameNorm: string;
    lawdCd: string;
    aptName: string | null;
    tradeTxCount: number;
    canonicalAreaCount: number;
  }> = [];
  for (const r of inv.rows) {
    const cid = String(r.complex_id);
    if (exclude.has(cid)) continue;
    if (!cid.startsWith("cx_")) continue;
    eligibleMeta.push({
      complexId: cid,
      aptNameNorm: String(r.apt_name_norm),
      lawdCd: String(r.lawd_cd),
      aptName: r.apt_name != null ? String(r.apt_name) : null,
      tradeTxCount: Number(r.trade_tx),
      canonicalAreaCount: Number(r.area_n),
    });
  }

  // Already ordered by SQL; take first 100 and load distinct areas.
  const selectedMeta = eligibleMeta.slice(0, TARGET_COUNT);
  const targets: Target[] = [];
  for (const m of selectedMeta) {
    const raw = await loadTradeAreas(db, m.aptNameNorm, m.lawdCd);
    const areas = dedupeAreas(raw);
    targets.push({
      ...m,
      tradeTxCount: areas.reduce((s, a) => s + a.txCount, 0),
      canonicalAreaCount: areas.length,
      areas,
    });
  }

  return {
    targets,
    poolSize: eligibleMeta.length,
    existingUnitMasterExcluded,
    selectionMs: Date.now() - t0,
  };
}

function plannedRows(targets: Target[]) {
  return targets.reduce((s, t) => s + t.areas.length, 0);
}

async function precheckTarget(
  db: Db,
  t: Target,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!t.complexId.startsWith("cx_")) {
    return { ok: false, reason: "complex_id not cx_" };
  }
  const master = await db.execute({
    sql: `SELECT complex_id, identity_status, sido_code, apt_name_norm, lawd_cd
          FROM apt_complex_master WHERE complex_id = ?`,
    args: [t.complexId],
  });
  if (master.rows.length === 0) {
    return { ok: false, reason: "master row missing" };
  }
  const row = master.rows[0]!;
  if (String(row.identity_status) !== "IDENTITY-READY") {
    return { ok: false, reason: `identity_status=${row.identity_status}` };
  }
  if (String(row.sido_code) !== "11") {
    return { ok: false, reason: `sido_code=${row.sido_code}` };
  }
  if (String(row.apt_name_norm) !== t.aptNameNorm || String(row.lawd_cd) !== t.lawdCd) {
    return { ok: false, reason: "apt_name_norm/lawd_cd mismatch vs selection" };
  }

  const existingCx = await count(
    db,
    `SELECT COUNT(*) c FROM apt_unit_types WHERE complex_key = ?`,
    [t.complexId],
  );
  if (existingCx > 0) {
    return { ok: false, reason: `existing cx_ unit rows=${existingCx}` };
  }

  if (t.areas.length === 0) {
    return { ok: false, reason: "no trade canonical areas" };
  }

  const keys = new Set<string>();
  for (const a of t.areas) {
    const ak = areaKey(a.exclusiveArea);
    if (!(ak > 0) || !Number.isFinite(ak)) {
      return { ok: false, reason: `invalid area ${a.exclusiveArea}` };
    }
    const utk = `${t.complexId}:ex${areaKeyStr(ak)}`;
    if (keys.has(utk)) {
      return { ok: false, reason: `duplicate planned unit_type_key ${utk}` };
    }
    keys.add(utk);
    const pk = await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_types WHERE unit_type_key = ?`,
      [utk],
    );
    if (pk > 0) {
      return { ok: false, reason: `unit_type_key already exists ${utk}` };
    }
  }

  // Same complex_key + areaKey among planned
  const areaKeys = t.areas.map((a) => areaKeyStr(a.exclusiveArea));
  if (new Set(areaKeys).size !== areaKeys.length) {
    return { ok: false, reason: "duplicate complex+areaKey in planned set" };
  }

  return { ok: true };
}

async function insertMissingUnits(db: Db, t: Target) {
  const inserted: string[] = [];
  const skipped: string[] = [];
  for (const a of t.areas) {
    const ak = areaKey(a.exclusiveArea);
    const aks = areaKeyStr(ak);
    const unitTypeKey = `${t.complexId}:ex${aks}`;
    const pk = await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_types WHERE unit_type_key = ?`,
      [unitTypeKey],
    );
    if (pk > 0) {
      skipped.push(unitTypeKey);
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
        t.complexId,
        null,
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
  return { inserted, skipped };
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });

  mkdirSync(join(process.cwd(), "data/poc/unit-area"), { recursive: true });

  const coverageBefore = await coverageSnapshot(db);
  const safetyBefore = await safetySnapshot(db);

  const {
    targets,
    poolSize,
    existingUnitMasterExcluded,
    selectionMs,
  } = await selectTargets(db);

  const selected = targets.length;
  const expectedUnitRows = plannedRows(targets);

  // Manifest build + precheck
  const tManifest0 = Date.now();
  const holds: Hold[] = [];
  let identityFailures = 0;
  let duplicateFailures = 0;
  let invalidAreaFailures = 0;
  let existingCxFailures = 0;
  const precheckDetails: Array<{
    complexId: string;
    aptNameNorm: string;
    expectedUnits: number;
    status: "PASS" | "HOLD";
    reason?: string;
  }> = [];

  for (const t of targets) {
    const pc = await precheckTarget(db, t);
    if (pc.ok) {
      precheckDetails.push({
        complexId: t.complexId,
        aptNameNorm: t.aptNameNorm,
        expectedUnits: t.areas.length,
        status: "PASS",
      });
    } else {
      holds.push({ complexId: t.complexId, reason: pc.reason });
      precheckDetails.push({
        complexId: t.complexId,
        aptNameNorm: t.aptNameNorm,
        expectedUnits: t.areas.length,
        status: "HOLD",
        reason: pc.reason,
      });
      if (pc.reason.includes("identity") || pc.reason.includes("master")) {
        identityFailures += 1;
      } else if (pc.reason.includes("duplicate") || pc.reason.includes("already exists")) {
        duplicateFailures += 1;
      } else if (pc.reason.includes("invalid area")) {
        invalidAreaFailures += 1;
      } else if (pc.reason.includes("existing cx_")) {
        existingCxFailures += 1;
      }
    }
  }

  const passTargets = targets.filter(
    (t) => !holds.some((h) => h.complexId === t.complexId),
  );
  const passExpectedRows = plannedRows(passTargets);
  const capExceeded = expectedUnitRows > MAX_NEW_UNIT_ROWS;
  const precheckStatus =
    selected === TARGET_COUNT &&
    holds.length === 0 &&
    !capExceeded
      ? "PASS"
      : selected === TARGET_COUNT && holds.length === 0 && capExceeded
        ? "HOLD"
        : selected < TARGET_COUNT
          ? "PARTIAL"
          : holds.length > 0
            ? "HOLD"
            : "PASS";

  const manifest = {
    generatedAt: new Date().toISOString(),
    stage: "stage22",
    dataType: "apt_unit_types",
    source: "transactions",
    scope: "trade-only",
    canonicalPrecision: "2 decimals",
    ruleVersion: RULE_VERSION,
    identityContract: {
      complexKey: "apt_complex_master.complex_id (cx_ only)",
      unitTypeKey: "{complex_id}:ex{areaKey}",
      areaKey: "Math.round(exclusive_area*100)/100",
      mappingConfidence: "transaction_raw_exclusive",
      supplyAreaSqm: null,
    },
    selection: {
      requested: TARGET_COUNT,
      selected,
      poolSize,
      existingUnitMasterExcluded,
      minTradeTx: MIN_TRADE_TX,
      canonicalAreaRange: [MIN_AREAS, MAX_AREAS],
      order: "trade_tx DESC, complex_id ASC",
      dealType: "trade",
      selectionMs,
    },
    targetComplexIds: targets.map((t) => t.complexId),
    targets: targets.map((t) => ({
      complexId: t.complexId,
      aptNameNorm: t.aptNameNorm,
      aptName: t.aptName,
      lawdCd: t.lawdCd,
      tradeTxCount: t.tradeTxCount,
      canonicalAreaCount: t.canonicalAreaCount,
      areaKeys: t.areas.map((a) => areaKey(a.exclusiveArea)),
    })),
    expected: {
      complexes: selected,
      unitRows: expectedUnitRows,
      passComplexes: passTargets.length,
      passUnitRows: passExpectedRows,
    },
    rowHardCap: MAX_NEW_UNIT_ROWS,
    capExceeded,
    precheck: {
      status: precheckStatus,
      identityFailures,
      duplicateFailures,
      invalidAreaFailures,
      existingCxFailures,
      holdCount: holds.length,
      holds,
      details: precheckDetails,
    },
  };

  writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 2));
  const manifestMs = Date.now() - tManifest0;

  let promotionAttempted = false;
  let unitRowsInserted = 0;
  let complexesPromoted = 0;
  const perComplex: Array<{
    complexId: string;
    aptNameNorm: string;
    aptName: string | null;
    tradeCanonical: number;
    afterCanonical: number;
    inserted: number;
    missing: number;
    status: "PASS" | "HOLD";
  }> = [];
  let insertMs = 0;
  let expansionStatus: "PASS" | "PARTIAL" | "HOLD" = "HOLD";

  // Explicit promotion only after full manifest precheck PASS (no silent subset load).
  if (precheckStatus === "PASS" && !capExceeded) {
    promotionAttempted = true;
    const tIns0 = Date.now();
    for (const t of passTargets) {
      const { inserted } = await insertMissingUnits(db, t);
      unitRowsInserted += inserted.length;
      complexesPromoted += 1;
    }
    insertMs = Date.now() - tIns0;
    expansionStatus = "PASS";
  } else if (capExceeded) {
    expansionStatus = "HOLD";
  } else if (selected < TARGET_COUNT) {
    expansionStatus = "PARTIAL";
  } else {
    expansionStatus = "HOLD";
  }

  // Postcheck
  const tPost0 = Date.now();
  let missingTotal = 0;
  let dupUnitTypeKey = 0;
  let dupComplexArea = 0;
  let newSlugWrites = 0;

  const promotedIds = new Set(
    promotionAttempted
      ? passTargets.map((t) => t.complexId)
      : [],
  );

  for (const t of targets) {
    if (!promotedIds.has(t.complexId) && holds.some((h) => h.complexId === t.complexId)) {
      perComplex.push({
        complexId: t.complexId,
        aptNameNorm: t.aptNameNorm,
        aptName: t.aptName,
        tradeCanonical: t.areas.length,
        afterCanonical: 0,
        inserted: 0,
        missing: t.areas.length,
        status: "HOLD",
      });
      missingTotal += t.areas.length;
      continue;
    }
    if (!promotedIds.has(t.complexId)) {
      perComplex.push({
        complexId: t.complexId,
        aptNameNorm: t.aptNameNorm,
        aptName: t.aptName,
        tradeCanonical: t.areas.length,
        afterCanonical: 0,
        inserted: 0,
        missing: t.areas.length,
        status: "HOLD",
      });
      continue;
    }

    const after = await existingUnits(db, t.complexId);
    const afterKeys = new Set(
      after
        .filter((u) => areaKey(u.exclusiveAreaMin) === areaKey(u.exclusiveAreaMax))
        .map((u) => areaKeyStr(u.exclusiveAreaMin)),
    );
    const tradeKeys = new Set(t.areas.map((a) => areaKeyStr(a.exclusiveArea)));
    const missing = [...tradeKeys].filter((k) => !afterKeys.has(k));
    missingTotal += missing.length;

    const areaCounts = new Map<string, number>();
    for (const u of after) {
      if (areaKey(u.exclusiveAreaMin) !== areaKey(u.exclusiveAreaMax)) continue;
      const k = areaKeyStr(u.exclusiveAreaMin);
      areaCounts.set(k, (areaCounts.get(k) ?? 0) + 1);
    }
    for (const c of areaCounts.values()) {
      if (c > 1) dupComplexArea += 1;
    }

    perComplex.push({
      complexId: t.complexId,
      aptNameNorm: t.aptNameNorm,
      aptName: t.aptName,
      tradeCanonical: tradeKeys.size,
      afterCanonical: afterKeys.size,
      inserted: after.length, // all new for this complex
      missing: missing.length,
      status: missing.length === 0 ? "PASS" : "HOLD",
    });
  }

  // Global integrity on newly promoted cx_ keys
  if (promotedIds.size > 0) {
    const ids = [...promotedIds];
    const placeholders = ids.map(() => "?").join(",");
    dupUnitTypeKey = await count(
      db,
      `SELECT COUNT(*) c FROM (
         SELECT unit_type_key FROM apt_unit_types
         WHERE complex_key IN (${placeholders})
         GROUP BY unit_type_key HAVING COUNT(*) > 1
       )`,
      ids,
    );
    const dupAreaRows = await db.execute({
      sql: `SELECT complex_key, ROUND(exclusive_area_min*100)/100 AS ak, COUNT(*) AS c
            FROM apt_unit_types
            WHERE complex_key IN (${placeholders})
            GROUP BY complex_key, ROUND(exclusive_area_min*100)/100
            HAVING COUNT(*) > 1`,
      args: ids,
    });
    dupComplexArea = dupAreaRows.rows.length;
  }
  newSlugWrites = 0; // Stage22 inserts cx_ only; confirmed via legacy count delta

  // Idempotency: verify-only replay (count would-be inserts)
  let idempotentNewInserts = 0;
  for (const t of passTargets) {
    if (!promotedIds.has(t.complexId)) continue;
    for (const a of t.areas) {
      const utk = `${t.complexId}:ex${areaKeyStr(a.exclusiveArea)}`;
      const pk = await count(
        db,
        `SELECT COUNT(*) c FROM apt_unit_types WHERE unit_type_key = ?`,
        [utk],
      );
      if (pk === 0) idempotentNewInserts += 1;
    }
  }

  const coverageAfter = await coverageSnapshot(db);
  const safetyAfter = await safetySnapshot(db);

  const areaCountsArr = perComplex
    .filter((p) => promotedIds.has(p.complexId))
    .map((p) => p.afterCanonical);
  const dist = {
    min: areaCountsArr.length ? Math.min(...areaCountsArr) : 0,
    median: median(areaCountsArr),
    max: areaCountsArr.length ? Math.max(...areaCountsArr) : 0,
    totalCanonicalUnits: areaCountsArr.reduce((s, n) => s + n, 0),
    buckets: {
      "1-3": areaCountsArr.filter((n) => n >= 1 && n <= 3).length,
      "4-7": areaCountsArr.filter((n) => n >= 4 && n <= 7).length,
      "8-12": areaCountsArr.filter((n) => n >= 8 && n <= 12).length,
      "13+": areaCountsArr.filter((n) => n >= 13).length,
    },
  };

  const top10 = [...perComplex]
    .filter((p) => promotedIds.has(p.complexId))
    .sort((a, b) => b.afterCanonical - a.afterCanonical || a.complexId.localeCompare(b.complexId))
    .slice(0, 10)
    .map((p) => ({
      complexId: p.complexId,
      aptNameNorm: p.aptNameNorm,
      aptName: p.aptName,
      canonicalUnitCount: p.afterCanonical,
    }));

  // Optional V1 candidate estimate (read-only, cheap)
  let v1Estimate: {
    performed: boolean;
    complexesWithCandidate: number;
    safeCandidateEstimate: number;
  } = { performed: false, complexesWithCandidate: 0, safeCandidateEstimate: 0 };
  {
    let withCand = 0;
    let safeN = 0;
    for (const t of passTargets) {
      if (!promotedIds.has(t.complexId)) continue;
      const cands = clusterByCommonRuleV1(t.areas);
      const safe = cands.filter((c) => c.decision === "SAFE_BY_COMMON_RULE");
      if (safe.length > 0) {
        withCand += 1;
        safeN += safe.length;
      }
    }
    v1Estimate = {
      performed: true,
      complexesWithCandidate: withCand,
      safeCandidateEstimate: safeN,
    };
  }

  const completenessStatus =
    promotionAttempted && missingTotal === 0 && holds.length === 0
      ? "PASS"
      : promotionAttempted && missingTotal === 0 && holds.length > 0
        ? "HOLD"
        : missingTotal === 0 && promotionAttempted
          ? "PASS"
          : "HOLD";

  const integrityStatus =
    dupUnitTypeKey === 0 &&
    dupComplexArea === 0 &&
    safetyAfter.apt_unit_types_legacy === safetyBefore.apt_unit_types_legacy
      ? "PASS"
      : "HOLD";

  const idempotencyStatus = idempotentNewInserts === 0 ? "PASS" : "HOLD";

  const dataSafety = {
    transactionsChanged:
      safetyAfter.transactions - safetyBefore.transactions,
    masterChanged:
      safetyAfter.apt_complex_master - safetyBefore.apt_complex_master,
    sourceLinksChanged:
      safetyBefore.apt_complex_source_links >= 0 &&
      safetyAfter.apt_complex_source_links >= 0
        ? safetyAfter.apt_complex_source_links -
          safetyBefore.apt_complex_source_links
        : 0,
    existingUnitRowsUpdated: 0,
    legacyRowsChanged:
      safetyAfter.apt_unit_types_legacy - safetyBefore.apt_unit_types_legacy,
    groupsChanged:
      safetyAfter.apt_pyeong_groups - safetyBefore.apt_pyeong_groups,
    linksChanged:
      safetyAfter.apt_unit_type_group_links -
      safetyBefore.apt_unit_type_group_links,
    baselinesChanged:
      safetyBefore.apt_pyeong_group_baselines >= 0 &&
      safetyAfter.apt_pyeong_group_baselines >= 0
        ? safetyAfter.apt_pyeong_group_baselines -
          safetyBefore.apt_pyeong_group_baselines
        : 0,
    classificationsChanged:
      safetyBefore.apt_complex_classifications >= 0 &&
      safetyAfter.apt_complex_classifications >= 0
        ? safetyAfter.apt_complex_classifications -
          safetyBefore.apt_complex_classifications
        : 0,
    unitTypesDelta:
      safetyAfter.apt_unit_types - safetyBefore.apt_unit_types,
  };

  const dataSafetyStatus =
    dataSafety.transactionsChanged === 0 &&
    dataSafety.masterChanged === 0 &&
    dataSafety.sourceLinksChanged === 0 &&
    dataSafety.legacyRowsChanged === 0 &&
    dataSafety.groupsChanged === 0 &&
    dataSafety.linksChanged === 0 &&
    dataSafety.baselinesChanged === 0 &&
    dataSafety.classificationsChanged === 0 &&
    dataSafety.unitTypesDelta === unitRowsInserted
      ? "PASS"
      : "HOLD";

  const postcheckMs = Date.now() - tPost0;

  // Next action heuristic
  let nextAction: "A" | "B" | "C" | "D" | "E" = "A";
  let nextReason =
    "Stage22 unit-master expansion PASS; continue bounded unit coverage before grouping.";
  if (expansionStatus !== "PASS" || integrityStatus !== "PASS") {
    nextAction = expansionStatus === "HOLD" ? "D" : "C";
    nextReason =
      expansionStatus === "HOLD"
        ? "Promotion path held; repair promotion/precheck before next batch."
        : "Partial/defect in expansion; repair before larger batch.";
  } else if (coverageAfter.unitMasterComplexes >= 500) {
    nextAction = "B";
    nextReason = "Unit-master base large enough to consider V1 grouping promotion.";
  }

  const report = {
    generatedAt: new Date().toISOString(),
    stage: "stage22-unit-expansion",
    officialContract: {
      scope: "Seoul IDENTITY-READY trade only",
      canonical: "Math.round(exclusive_area*100)/100",
      officialRawIdentitiesBefore: coverageBefore.canonicalRawTradeIdentities,
      officialRawIdentitiesAfter: coverageAfter.canonicalRawTradeIdentities,
    },
    selection: {
      requested: TARGET_COUNT,
      selected,
      poolSize,
      selectionRule:
        "Seoul IDENTITY-READY cx_; deal_type=trade; exclusive_area>0; exclude existing cx_ unit-master; trade_tx>=50; canonical areas 2–20; ORDER BY trade_tx DESC, complex_id ASC",
      existingUnitMasterExcluded: true,
      existingUnitMasterExcludedCount: existingUnitMasterExcluded,
      newSlugCandidates: 0,
    },
    manifest: {
      path: "data/poc/unit-area/stage22-unit-promotion-manifest.json",
      targetComplexes: selected,
      expectedUnitRows,
      precheck: precheckStatus,
      identityFailures,
      duplicates: duplicateFailures,
      invalidAreas: invalidAreaFailures,
      rowHardCap: MAX_NEW_UNIT_ROWS,
      expectedRows: expectedUnitRows,
      capExceeded: capExceeded ? "YES" : "NO",
    },
    productionPromotion: {
      attempted: promotionAttempted ? "YES" : "NO",
      complexesPromoted,
      unitRowsInserted,
      unitRowsUpdated: 0,
      unitRowsDeleted: 0,
    },
    completeness: {
      targetCanonicalTradeIdentities: expectedUnitRows,
      afterLoadCanonicalIdentities: dist.totalCanonicalUnits,
      missing: missingTotal,
      duplicates: dupComplexArea,
      status: completenessStatus,
      perComplexSummaryOnly: true,
      holdOrProblem: perComplex.filter((p) => p.status === "HOLD").slice(0, 20),
    },
    newCxIntegrity: {
      duplicateUnitTypeKey: dupUnitTypeKey,
      duplicateComplexAreaKey: dupComplexArea,
      newSlugWrites:
        dataSafety.legacyRowsChanged === 0 ? 0 : dataSafety.legacyRowsChanged,
      status: integrityStatus,
    },
    distribution: dist,
    top10,
    optionalV1CandidateEstimate: {
      ...v1Estimate,
      groupWrites: 0,
    },
    coverageBefore,
    coverageAfter,
    coverageDelta: {
      unitMasterComplexes: `${coverageBefore.unitMasterComplexes} → ${coverageAfter.unitMasterComplexes}`,
      canonicalUnitIdentities: `${coverageBefore.unitMasterCanonicalIdentities} → ${coverageAfter.unitMasterCanonicalIdentities}`,
    },
    idempotency: {
      verifyOnlyReplayNewInserts: idempotentNewInserts,
      status: idempotencyStatus,
    },
    dataSafety: {
      ...dataSafety,
      status: dataSafetyStatus,
    },
    timing: {
      selectionMs,
      manifestMs,
      insertMs,
      postcheckMs,
    },
    db: {
      apt_unit_types_insert: unitRowsInserted,
      apt_unit_types_update: 0,
      all_other_business_inserts: 0,
      delete: 0,
    },
    nextAction: {
      choice: nextAction,
      reason: nextReason,
    },
    decision: {
      MANIFEST_PRECHECK: precheckStatus === "PASS" ? "PASS" : "HOLD",
      "100_COMPLEX_UNIT_EXPANSION": expansionStatus,
      CANONICAL_COMPLETENESS: completenessStatus,
      NEW_CX_INTEGRITY: integrityStatus,
      IDEMPOTENCY: idempotencyStatus,
      PROMOTION_CONTRACT_PRACTICAL_TEST:
        promotionAttempted && dataSafetyStatus === "PASS" ? "PASS" : "HOLD",
      DATA_SAFETY: dataSafetyStatus,
    },
  };

  writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2));

  console.log(
    JSON.stringify(
      {
        out: { manifest: MANIFEST_OUT, report: REPORT_OUT },
        selected,
        expectedUnitRows,
        precheckStatus,
        promotionAttempted,
        unitRowsInserted,
        complexesPromoted,
        coverageBefore,
        coverageAfter,
        decision: report.decision,
        nextAction: report.nextAction,
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
