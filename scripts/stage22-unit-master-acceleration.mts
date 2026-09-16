/**
 * STAGE 22 — 100-complex unit-master acceleration (manifest-gated Production).
 *
 * Writes: apt_unit_types INSERT only (manifest targets, cx_ keys, missing rows).
 * Forbidden: groups, links, baselines, classifications, UPDATE/DELETE, slug keys,
 *            transactions/master mutation, external APIs, singoga.
 *
 * Stage23: selection/manifest/insert/postcheck use bounded batch helpers
 * (scripts/lib/unit-master-promotion-path.ts). Semantics unchanged.
 */
import { createClient, type InArgs } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  areaKey,
  areaKeyStr,
  clusterByCommonRuleV1,
} from "./lib/stage9-grouping-contract";
import {
  batchInsertUnits,
  batchLoadExistingUnits,
  batchLoadMasterRows,
  batchLoadTradeAreasByComplexIds,
  buildTargetsFromMeta,
  compareManifestIdentities,
  fetchExistingCxUnitKeys,
  filterMissingUnits,
  planUnits,
  selectEligibleInventory,
  type UnitTarget,
} from "./lib/unit-master-promotion-path";

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
type Target = UnitTarget;
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

async function selectTargets(db: Db): Promise<{
  targets: Target[];
  poolSize: number;
  existingUnitMasterExcluded: number;
  selectionMs: number;
}> {
  const t0 = Date.now();
  const exclude = await fetchExistingCxUnitKeys(db);
  const existingUnitMasterExcluded = exclude.size;

  const eligibleMeta = await selectEligibleInventory(db, {
    minTradeTx: MIN_TRADE_TX,
    minAreas: MIN_AREAS,
    maxAreas: MAX_AREAS,
    exclude,
  });

  const selectedMeta = eligibleMeta.slice(0, TARGET_COUNT);
  const ids = selectedMeta.map((m) => m.complexId);
  const areasById = await batchLoadTradeAreasByComplexIds(db, ids);
  const targets = buildTargetsFromMeta(selectedMeta, areasById);

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

  // Manifest build + batched precheck
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

  const ids = targets.map((t) => t.complexId);
  const masters = await batchLoadMasterRows(db, ids);
  const existingUnitsMap = await batchLoadExistingUnits(db, ids);
  const planned = planUnits(targets);
  const plannedKeySet = new Set(planned.map((p) => p.unitTypeKey));
  if (plannedKeySet.size !== planned.length) {
    duplicateFailures += planned.length - plannedKeySet.size;
  }

  for (const t of targets) {
    let reason: string | null = null;
    if (!t.complexId.startsWith("cx_")) reason = "complex_id not cx_";
    const m = masters.get(t.complexId);
    if (!reason && !m) reason = "master row missing";
    if (!reason && m!.identityStatus !== "IDENTITY-READY") {
      reason = `identity_status=${m!.identityStatus}`;
    }
    if (!reason && m!.sidoCode !== "11") reason = `sido_code=${m!.sidoCode}`;
    if (
      !reason &&
      (m!.aptNameNorm !== t.aptNameNorm || m!.lawdCd !== t.lawdCd)
    ) {
      reason = "apt_name_norm/lawd_cd mismatch vs selection";
    }
    const existing = existingUnitsMap.get(t.complexId) ?? [];
    if (!reason && existing.length > 0) {
      reason = `existing cx_ unit rows=${existing.length}`;
    }
    if (!reason && t.areas.length === 0) reason = "no trade canonical areas";
    for (const a of t.areas) {
      if (reason) break;
      const ak = areaKey(a.exclusiveArea);
      if (!(ak > 0) || !Number.isFinite(ak)) {
        reason = `invalid area ${a.exclusiveArea}`;
      }
    }
    const areaKeys = t.areas.map((a) => areaKeyStr(a.exclusiveArea));
    if (!reason && new Set(areaKeys).size !== areaKeys.length) {
      reason = "duplicate complex+areaKey in planned set";
    }
    for (const a of t.areas) {
      if (reason) break;
      const utk = `${t.complexId}:ex${areaKeyStr(a.exclusiveArea)}`;
      if ((existingUnitsMap.get(t.complexId) ?? []).some((u) => u.unitTypeKey === utk)) {
        reason = `unit_type_key already exists ${utk}`;
      }
    }

    if (!reason) {
      precheckDetails.push({
        complexId: t.complexId,
        aptNameNorm: t.aptNameNorm,
        expectedUnits: t.areas.length,
        status: "PASS",
      });
    } else {
      holds.push({ complexId: t.complexId, reason });
      precheckDetails.push({
        complexId: t.complexId,
        aptNameNorm: t.aptNameNorm,
        expectedUnits: t.areas.length,
        status: "HOLD",
        reason,
      });
      if (reason.includes("identity") || reason.includes("master")) {
        identityFailures += 1;
      } else if (
        reason.includes("duplicate") ||
        reason.includes("already exists")
      ) {
        duplicateFailures += 1;
      } else if (reason.includes("invalid area")) {
        invalidAreaFailures += 1;
      } else if (reason.includes("existing cx_")) {
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

  if (precheckStatus === "PASS" && !capExceeded) {
    promotionAttempted = true;
    const tIns0 = Date.now();
    const existingNow = await batchLoadExistingUnits(
      db,
      passTargets.map((t) => t.complexId),
    );
    const missing = filterMissingUnits(planUnits(passTargets), existingNow);
    const { inserted } = await batchInsertUnits(db, missing);
    unitRowsInserted = inserted;
    complexesPromoted = passTargets.length;
    insertMs = Date.now() - tIns0;
    expansionStatus = "PASS";
  } else if (capExceeded) {
    expansionStatus = "HOLD";
  } else if (selected < TARGET_COUNT) {
    expansionStatus = "PARTIAL";
  } else {
    expansionStatus = "HOLD";
  }

  // Postcheck — batched
  const tPost0 = Date.now();
  let missingTotal = 0;
  let dupUnitTypeKey = 0;
  let dupComplexArea = 0;

  const promotedIds = new Set(
    promotionAttempted ? passTargets.map((t) => t.complexId) : [],
  );

  const afterMap =
    promotedIds.size > 0
      ? await batchLoadExistingUnits(db, [...promotedIds])
      : new Map();

  for (const t of targets) {
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
      missingTotal += t.areas.length;
      continue;
    }

    const after = afterMap.get(t.complexId) ?? [];
    const afterKeys = new Set(
      after
        .filter(
          (u) => areaKey(u.exclusiveAreaMin) === areaKey(u.exclusiveAreaMax),
        )
        .map((u) => areaKeyStr(u.exclusiveAreaMin)),
    );
    const tradeKeys = new Set(t.areas.map((a) => areaKeyStr(a.exclusiveArea)));
    const missing = [...tradeKeys].filter((k) => !afterKeys.has(k));
    missingTotal += missing.length;

    perComplex.push({
      complexId: t.complexId,
      aptNameNorm: t.aptNameNorm,
      aptName: t.aptName,
      tradeCanonical: tradeKeys.size,
      afterCanonical: afterKeys.size,
      inserted: after.length,
      missing: missing.length,
      status: missing.length === 0 ? "PASS" : "HOLD",
    });
  }

  if (promotedIds.size > 0) {
    const cmp = compareManifestIdentities(
      planUnits(passTargets),
      afterMap,
    );
    dupUnitTypeKey = cmp.duplicateUnitTypeKey;
    dupComplexArea = cmp.duplicateComplexArea;
  }

  // Idempotency verify-only (in-memory against batch fetch)
  let idempotentNewInserts = 0;
  if (promotedIds.size > 0) {
    const replayExisting = await batchLoadExistingUnits(db, [...promotedIds]);
    idempotentNewInserts = filterMissingUnits(
      planUnits(passTargets),
      replayExisting,
    ).length;
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
    .sort(
      (a, b) =>
        b.afterCanonical - a.afterCanonical ||
        a.complexId.localeCompare(b.complexId),
    )
    .slice(0, 10)
    .map((p) => ({
      complexId: p.complexId,
      aptNameNorm: p.aptNameNorm,
      aptName: p.aptName,
      canonicalUnitCount: p.afterCanonical,
    }));

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
    nextReason =
      "Unit-master base large enough to consider V1 grouping promotion.";
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
