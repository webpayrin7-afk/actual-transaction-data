/**
 * STAGE 24 — 250-complex unit-master promotion (optimized Stage23 path).
 * Real Production INSERT via db.batch; no grouping/singoga/external APIs.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  areaKey,
  areaKeyStr,
  clusterByCommonRuleV1,
} from "./lib/stage9-grouping-contract";
import {
  UNIT_INSERT_CHUNK,
  batchLoadExistingUnits,
  batchLoadMasterRows,
  batchLoadTradeAreasByComplexIds,
  buildTargetsFromMeta,
  compareManifestIdentities,
  fetchExistingCxUnitKeys,
  filterMissingUnits,
  freshCounter,
  insertStatements,
  planUnits,
  selectEligibleInventory,
  type PlannedUnit,
  type QueryCounter,
  type UnitTarget,
} from "./lib/unit-master-promotion-path";

config({ path: ".env.local" });
config();

const MANIFEST_OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage24-unit-promotion-manifest.json",
);
const REPORT_OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage24-unit-expansion.json",
);

const TARGET_COUNT = 250;
const MIN_TRADE_TX = 50;
const MIN_AREAS = 2;
const MAX_AREAS = 20;
const MAX_NEW_UNIT_ROWS = 2500;
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

async function count(db: Db, sql: string, args: (string | number)[] = []) {
  const r = await db.execute({ sql, args });
  return Number(r.rows[0]!.c);
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

async function safetyCounts(db: Db) {
  return {
    transactions: await count(db, `SELECT COUNT(*) c FROM transactions`),
    master: await count(db, `SELECT COUNT(*) c FROM apt_complex_master`),
    units: await count(db, `SELECT COUNT(*) c FROM apt_unit_types`),
    legacy: await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_types WHERE complex_key NOT LIKE 'cx_%'`,
    ),
    groups: await count(db, `SELECT COUNT(*) c FROM apt_pyeong_groups`),
    links: await count(db, `SELECT COUNT(*) c FROM apt_unit_type_group_links`),
    baselines: await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_group_baselines`,
    ).catch(() => -1),
    classifications: await count(
      db,
      `SELECT COUNT(*) c FROM apt_complex_classifications`,
    ).catch(() => -1),
  };
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

async function runFirstBatchSanity(
  db: Db,
  chunk: PlannedUnit[],
  counter: QueryCounter,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const keys = chunk.map((p) => p.unitTypeKey);
  const ph = keys.map(() => "?").join(",");
  counter.queries += 1;
  counter.networkCalls += 1;
  const r = await db.execute({
    sql: `SELECT unit_type_key, complex_key, exclusive_area_min, exclusive_area_max,
                 source, mapping_confidence
          FROM apt_unit_types WHERE unit_type_key IN (${ph})`,
    args: keys,
  });
  counter.rows += r.rows.length;
  if (r.rows.length !== keys.length) {
    return {
      ok: false,
      reason: `first-batch missing rows: expected ${keys.length} got ${r.rows.length}`,
    };
  }
  const seen = new Set<string>();
  for (const row of r.rows) {
    const utk = String(row.unit_type_key);
    if (seen.has(utk)) {
      return { ok: false, reason: `first-batch duplicate unit_type_key ${utk}` };
    }
    seen.add(utk);
    const ck = String(row.complex_key);
    if (!ck.startsWith("cx_")) {
      return { ok: false, reason: `first-batch non-cx_ key ${ck}` };
    }
    const amin = Number(row.exclusive_area_min);
    const amax = Number(row.exclusive_area_max);
    if (!(amin > 0) || areaKey(amin) !== areaKey(amax)) {
      return { ok: false, reason: `first-batch malformed area ${utk}` };
    }
    if (String(row.source) !== "transactions") {
      return { ok: false, reason: `first-batch bad source ${utk}` };
    }
    if (String(row.mapping_confidence) !== "transaction_raw_exclusive") {
      return { ok: false, reason: `first-batch bad confidence ${utk}` };
    }
  }
  return { ok: true };
}

async function batchInsertWithFirstSanity(
  db: Db,
  missing: PlannedUnit[],
  counter: QueryCounter,
): Promise<{
  inserted: number;
  batchCalls: number;
  firstBatchSanity: "PASS" | "HOLD";
  stoppedEarly: boolean;
  stopReason: string | null;
  insertMs: number;
}> {
  const t0 = Date.now();
  const stmts = insertStatements(missing);
  let batchCalls = 0;
  let inserted = 0;
  let firstBatchSanity: "PASS" | "HOLD" = "PASS";
  let stoppedEarly = false;
  let stopReason: string | null = null;

  for (let i = 0; i < stmts.length; i += UNIT_INSERT_CHUNK) {
    const chunkUnits = missing.slice(i, i + UNIT_INSERT_CHUNK);
    const chunkStmts = stmts.slice(i, i + UNIT_INSERT_CHUNK);
    await db.batch(chunkStmts, "write");
    batchCalls += 1;
    counter.networkCalls += 1;
    counter.queries += chunkStmts.length;
    inserted += chunkUnits.length;

    if (batchCalls === 1) {
      const sanity = await runFirstBatchSanity(db, chunkUnits, counter);
      if (!sanity.ok) {
        firstBatchSanity = "HOLD";
        stoppedEarly = true;
        stopReason = sanity.reason;
        break;
      }
    }
  }

  return {
    inserted,
    batchCalls,
    firstBatchSanity,
    stoppedEarly,
    stopReason,
    insertMs: Date.now() - t0,
  };
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });
  mkdirSync(join(process.cwd(), "data/poc/unit-area"), { recursive: true });

  const coverageBefore = await coverageSnapshot(db);
  const safetyBefore = await safetyCounts(db);

  // ---- Selection (or resume from prior Stage24 manifest after partial insert) ----
  const selCounter = freshCounter();
  const tSel0 = Date.now();
  const exclude = await fetchExistingCxUnitKeys(db, selCounter);

  let targets: UnitTarget[] = [];
  let eligibleCount = 0;
  let resumedFromManifest = false;

  const priorManifest =
    existsSync(MANIFEST_OUT)
      ? (JSON.parse(readFileSync(MANIFEST_OUT, "utf8")) as {
          stage?: string;
          targetComplexIds?: string[];
          targets?: Array<{
            complexId: string;
            aptNameNorm: string;
            aptName: string | null;
            lawdCd: string;
          }>;
          precheck?: { status?: string };
          expected?: { units?: number };
        })
      : null;

  if (
    priorManifest?.stage === "stage24" &&
    priorManifest.precheck?.status === "PASS" &&
    Array.isArray(priorManifest.targetComplexIds) &&
    priorManifest.targetComplexIds.length === TARGET_COUNT &&
    Array.isArray(priorManifest.targets) &&
    priorManifest.targets.length === TARGET_COUNT
  ) {
    // Resume exact Stage24 target set (insert-missing only). Do not re-rank,
    // because a partial first batch would otherwise exclude these complexes.
    resumedFromManifest = true;
    eligibleCount = TARGET_COUNT;
    const targetIds = priorManifest.targetComplexIds;
    const areasById = await batchLoadTradeAreasByComplexIds(
      db,
      targetIds,
      selCounter,
    );
    targets = buildTargetsFromMeta(priorManifest.targets, areasById);
  } else {
    const inventory = await selectEligibleInventory(
      db,
      {
        minTradeTx: MIN_TRADE_TX,
        minAreas: MIN_AREAS,
        maxAreas: MAX_AREAS,
        exclude,
      },
      selCounter,
    );
    eligibleCount = inventory.length;

    if (eligibleCount < TARGET_COUNT) {
      const hold = {
        generatedAt: new Date().toISOString(),
        stage: "stage24",
        status: "HOLD",
        reason: "ELIGIBLE_COUNT_SHORTAGE",
        ELIGIBLE_COUNT: eligibleCount,
        requested: TARGET_COUNT,
        thresholdsUnchanged: {
          minTradeTx: MIN_TRADE_TX,
          areaRange: [MIN_AREAS, MAX_AREAS],
        },
      };
      writeFileSync(MANIFEST_OUT, JSON.stringify(hold, null, 2));
      writeFileSync(REPORT_OUT, JSON.stringify(hold, null, 2));
      console.log(JSON.stringify(hold, null, 2));
      return;
    }

    const selectedMeta = inventory.slice(0, TARGET_COUNT);
    const targetIds = selectedMeta.map((m) => m.complexId);
    const areasById = await batchLoadTradeAreasByComplexIds(
      db,
      targetIds,
      selCounter,
    );
    targets = buildTargetsFromMeta(selectedMeta, areasById);
  }

  const targetIds = targets.map((t) => t.complexId);
  const selectionMs = Date.now() - tSel0;

  // ---- Manifest + precheck ----
  const manCounter = freshCounter();
  const tMan0 = Date.now();
  const masters = await batchLoadMasterRows(db, targetIds, manCounter);
  const existing = await batchLoadExistingUnits(db, targetIds, manCounter);
  const planned = planUnits(targets);
  const plannedKeySet = new Set(planned.map((p) => p.unitTypeKey));

  let identityFailures = 0;
  let duplicateFailures = 0;
  let invalidAreas = 0;
  let unexpectedExisting = 0;
  let nullRequired = 0;
  const holds: Array<{ complexId: string; reason: string }> = [];
  const seenPlanKeys = new Set<string>();

  for (const t of targets) {
    let reason: string | null = null;
    if (!t.complexId.startsWith("cx_")) reason = "not cx_";
    const m = masters.get(t.complexId);
    if (!reason && !m) {
      reason = "master missing";
      identityFailures += 1;
    }
    if (!reason && m!.identityStatus !== "IDENTITY-READY") {
      reason = `identity=${m!.identityStatus}`;
      identityFailures += 1;
    }
    if (!reason && m!.sidoCode !== "11") {
      reason = `sido=${m!.sidoCode}`;
      identityFailures += 1;
    }
    if (
      !reason &&
      (m!.aptNameNorm !== t.aptNameNorm || m!.lawdCd !== t.lawdCd)
    ) {
      reason = "name/lawd mismatch";
      identityFailures += 1;
    }
    const ex = existing.get(t.complexId) ?? [];
    for (const u of ex) {
      if (!plannedKeySet.has(u.unitTypeKey)) {
        unexpectedExisting += 1;
        if (!reason) reason = `unexpected existing unit ${u.unitTypeKey}`;
      }
    }
    if (!reason && t.areas.length === 0) reason = "no areas";
    const aks = t.areas.map((a) => areaKeyStr(a.exclusiveArea));
    if (!reason && new Set(aks).size !== aks.length) {
      reason = "duplicate areaKey in plan";
      duplicateFailures += 1;
    }
    for (const a of t.areas) {
      if (reason) break;
      const ak = areaKey(a.exclusiveArea);
      if (!(ak > 0) || !Number.isFinite(ak)) {
        reason = `invalid area ${a.exclusiveArea}`;
        invalidAreas += 1;
      }
      const utk = `${t.complexId}:ex${areaKeyStr(ak)}`;
      if (!t.complexId || !utk) nullRequired += 1;
      if (seenPlanKeys.has(utk)) {
        reason = `dup unit_type_key ${utk}`;
        duplicateFailures += 1;
      }
      seenPlanKeys.add(utk);
    }
    if (reason) holds.push({ complexId: t.complexId, reason });
  }

  const expectedUnits = planned.length;
  const missingPlanned = filterMissingUnits(planned, existing);
  const expectedInserts = missingPlanned.length;
  const existingTargetUnitCount = [...existing.values()].reduce(
    (s, rows) => s + rows.length,
    0,
  );
  // Fresh run expects 0 existing; resume allows planned subset already present.
  const existingCxUnitsFreshViolation =
    !resumedFromManifest && existingTargetUnitCount > 0 ? existingTargetUnitCount : 0;
  const capExceeded = expectedUnits > MAX_NEW_UNIT_ROWS;
  const precheckPass =
    targets.length === TARGET_COUNT &&
    holds.length === 0 &&
    identityFailures === 0 &&
    duplicateFailures === 0 &&
    invalidAreas === 0 &&
    unexpectedExisting === 0 &&
    existingCxUnitsFreshViolation === 0 &&
    nullRequired === 0 &&
    !capExceeded;

  const manifest = {
    generatedAt: new Date().toISOString(),
    stage: "stage24",
    dataType: "apt_unit_types",
    scope: "trade-only",
    canonicalPrecision: 2,
    source: "transactions",
    mappingContract: "transaction_raw_exclusive",
    ruleVersion: RULE_VERSION,
    resumedFromManifest,
    selection: {
      requested: TARGET_COUNT,
      eligible: eligibleCount,
      selected: targets.length,
      minTradeTx: MIN_TRADE_TX,
      canonicalAreaRange: [MIN_AREAS, MAX_AREAS],
      order: "trade_tx DESC, complex_id ASC",
      existingCxExcluded: exclude.size,
      selectionMs,
      selectionQueries: selCounter.queries,
    },
    targetComplexIds: targetIds,
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
      complexes: targets.length,
      units: expectedUnits,
      inserts: expectedInserts,
    },
    existingTargetUnitCount,
    rowHardCap: MAX_NEW_UNIT_ROWS,
    capExceeded,
    precheck: {
      status: precheckPass ? "PASS" : "HOLD",
      identityFailures,
      duplicateFailures,
      invalidAreas,
      existingCxUnits: existingCxUnitsFreshViolation,
      unexpectedExisting,
      nullRequired,
      newSlugCandidates: 0,
      holds,
      deterministic: true,
    },
  };
  writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 2));
  const manifestMs = Date.now() - tMan0;

  let promotionAttempted = false;
  let insertResult: Awaited<ReturnType<typeof batchInsertWithFirstSanity>> | null =
    null;
  const insertCounter = freshCounter();

  if (capExceeded) {
    // HOLD_UNIT_ROW_BUDGET — no write
  } else if (precheckPass && expectedInserts > 0) {
    promotionAttempted = true;
    insertResult = await batchInsertWithFirstSanity(
      db,
      missingPlanned,
      insertCounter,
    );
  } else if (precheckPass && expectedInserts === 0) {
    // Already complete (idempotent re-run)
    promotionAttempted = true;
    insertResult = {
      inserted: 0,
      batchCalls: 0,
      firstBatchSanity: "PASS",
      stoppedEarly: false,
      stopReason: null,
      insertMs: 0,
    };
  }

  // ---- Postcheck ----
  const postCounter = freshCounter();
  const tPost0 = Date.now();
  const afterMap = await batchLoadExistingUnits(db, targetIds, postCounter);
  const integrity = compareManifestIdentities(planned, afterMap);

  let incompleteComplexes = 0;
  const incompleteExamples: Array<{
    complexId: string;
    expected: number;
    actual: number;
  }> = [];
  const areaCounts: number[] = [];
  for (const t of targets) {
    const rows = afterMap.get(t.complexId) ?? [];
    const afterKeys = new Set(
      rows
        .filter(
          (u) => areaKey(u.exclusiveAreaMin) === areaKey(u.exclusiveAreaMax),
        )
        .map((u) => areaKeyStr(u.exclusiveAreaMin)),
    );
    const expected = t.areas.length;
    areaCounts.push(afterKeys.size);
    if (afterKeys.size !== expected) {
      incompleteComplexes += 1;
      if (incompleteExamples.length < 20) {
        incompleteExamples.push({
          complexId: t.complexId,
          expected,
          actual: afterKeys.size,
        });
      }
    }
  }

  const legacyAfter = await count(
    db,
    `SELECT COUNT(*) c FROM apt_unit_types WHERE complex_key NOT LIKE 'cx_%'`,
  );
  const newSlugWrites = legacyAfter - safetyBefore.legacy;

  // Idempotency verify-only
  const wouldInsert = filterMissingUnits(planned, afterMap).length;

  const postcheckMs = Date.now() - tPost0;
  const coverageAfter = await coverageSnapshot(db);
  const safetyAfter = await safetyCounts(db);

  // Optional V1 estimate (in-memory from already loaded areas)
  let withCand = 0;
  let safeGroups = 0;
  for (const t of targets) {
    const cands = clusterByCommonRuleV1(t.areas);
    const safe = cands.filter((c) => c.decision === "SAFE_BY_COMMON_RULE");
    if (safe.length > 0) {
      withCand += 1;
      safeGroups += safe.length;
    }
  }

  const rowsInserted = insertResult?.inserted ?? 0;
  const batchCalls = insertResult?.batchCalls ?? 0;
  const firstBatchSanity = insertResult?.firstBatchSanity ?? "HOLD";
  const insertMs = insertResult?.insertMs ?? 0;

  const postcheckStatus =
    promotionAttempted &&
    !insertResult?.stoppedEarly &&
    integrity.missing.length === 0 &&
    integrity.duplicateComplexArea === 0 &&
    integrity.duplicateUnitTypeKey === 0 &&
    newSlugWrites === 0 &&
    incompleteComplexes === 0
      ? "PASS"
      : "HOLD";

  const dataSafety = {
    transactionsWrites: safetyAfter.transactions - safetyBefore.transactions,
    masterWrites: safetyAfter.master - safetyBefore.master,
    existingUnitUpdates: 0,
    legacyWrites: newSlugWrites,
    groupWrites: safetyAfter.groups - safetyBefore.groups,
    linkWrites: safetyAfter.links - safetyBefore.links,
    baselineWrites:
      safetyBefore.baselines >= 0 && safetyAfter.baselines >= 0
        ? safetyAfter.baselines - safetyBefore.baselines
        : 0,
    classificationWrites:
      safetyBefore.classifications >= 0 && safetyAfter.classifications >= 0
        ? safetyAfter.classifications - safetyBefore.classifications
        : 0,
    snapshotStatsWrites: 0,
    unitDelta: safetyAfter.units - safetyBefore.units,
  };

  const dataSafetyPass =
    dataSafety.transactionsWrites === 0 &&
    dataSafety.masterWrites === 0 &&
    dataSafety.legacyWrites === 0 &&
    dataSafety.groupWrites === 0 &&
    dataSafety.linkWrites === 0 &&
    dataSafety.baselineWrites === 0 &&
    dataSafety.classificationWrites === 0 &&
    dataSafety.unitDelta === rowsInserted;

  const totalMs = selectionMs + manifestMs + insertMs + postcheckMs;
  const denomChanged =
    coverageBefore.canonicalRawTradeIdentities !==
    coverageAfter.canonicalRawTradeIdentities;

  const scaleReady =
    postcheckStatus === "PASS" &&
    wouldInsert === 0 &&
    dataSafetyPass &&
    firstBatchSanity === "PASS" &&
    !insertResult?.stoppedEarly;

  let nextAction: "A" | "B" | "C" | "D" | "E" = "A";
  let nextReason =
    "Stage24 real batch insert PASS; path ready for bounded 500-complex unit-master promotion.";
  if (!precheckPass || capExceeded) {
    nextAction = capExceeded ? "C" : "D";
    nextReason = capExceeded
      ? "HOLD_UNIT_ROW_BUDGET — refine selection/budget before larger batch."
      : "Manifest/precheck HOLD — repair before further promotion.";
  } else if (!scaleReady) {
    nextAction = insertResult?.stoppedEarly ? "C" : "D";
    nextReason = insertResult?.stoppedEarly
      ? "First-batch sanity or insert path issue — refine performance/path."
      : "Integrity incomplete — repair before 500.";
  }

  const report = {
    generatedAt: new Date().toISOString(),
    stage: "stage24-unit-expansion",
    contract: {
      scope: "Seoul IDENTITY-READY trade only",
      canonicalRule: "Math.round(exclusive_area*100)/100",
      source: "transactions",
      officialDenominatorBefore: coverageBefore.canonicalRawTradeIdentities,
      officialDenominatorAfter: coverageAfter.canonicalRawTradeIdentities,
      denominatorDelta: denomChanged
        ? {
            before: coverageBefore.canonicalRawTradeIdentities,
            after: coverageAfter.canonicalRawTradeIdentities,
            delta:
              coverageAfter.canonicalRawTradeIdentities -
              coverageBefore.canonicalRawTradeIdentities,
            reason: "underlying transactions/master may have changed",
          }
        : null,
    },
    selection: {
      requested: TARGET_COUNT,
      eligible: eligibleCount,
      selected: targets.length,
      selectionRule:
        "Seoul IDENTITY-READY cx_; deal_type=trade; exclusive_area>0; exclude existing cx_ unit-master; trade_tx>=50; areas 2–20; ORDER BY trade_tx DESC, complex_id ASC",
      ms: selectionMs,
      queries: selCounter.queries,
    },
    manifest: {
      path: "data/poc/unit-area/stage24-unit-promotion-manifest.json",
      targetComplexes: targets.length,
      expectedCanonicalUnits: expectedUnits,
      expectedInserts,
      identityFailures,
      duplicates: duplicateFailures,
      invalidAreas,
      existingCxUnits: existingCxUnitsFreshViolation,
      existingTargetUnitCountAtStart: existingTargetUnitCount,
      resumedFromManifest,
      newSlugCandidates: 0,
      precheck: precheckPass ? "PASS" : "HOLD",
      holdUnitRowBudget: capExceeded,
    },
    rowBudget: {
      hardCap: MAX_NEW_UNIT_ROWS,
      expected: expectedUnits,
      exceeded: capExceeded ? "YES" : "NO",
    },
    productionInsert: {
      attempted: promotionAttempted ? "YES" : "NO",
      rowsInserted,
      batchChunkSize: UNIT_INSERT_CHUNK,
      batchCalls,
      avgRowsPerBatch:
        batchCalls > 0 ? Math.round((rowsInserted / batchCalls) * 100) / 100 : 0,
      firstBatchSanity,
      stoppedEarly: insertResult?.stoppedEarly ?? false,
      stopReason: insertResult?.stopReason ?? null,
      insertRuntimeMs: insertMs,
      insertNetworkCalls: insertCounter.networkCalls,
    },
    postcheck: {
      expectedIdentities: expectedUnits,
      actualIdentities: integrity.present,
      missing: integrity.missing.length,
      duplicateUnitKeys: integrity.duplicateUnitTypeKey,
      duplicateComplexAreaKey: integrity.duplicateComplexArea,
      newSlugWrites,
      status: postcheckStatus,
      ms: postcheckMs,
      queries: postCounter.queries,
    },
    completeness: {
      complexesChecked: targets.length,
      complete: targets.length - incompleteComplexes,
      incomplete: incompleteComplexes,
      incompleteExamples,
    },
    distribution: {
      min: areaCounts.length ? Math.min(...areaCounts) : 0,
      median: median(areaCounts),
      max: areaCounts.length ? Math.max(...areaCounts) : 0,
      buckets: {
        "1-3": areaCounts.filter((n) => n >= 1 && n <= 3).length,
        "4-7": areaCounts.filter((n) => n >= 4 && n <= 7).length,
        "8-12": areaCounts.filter((n) => n >= 8 && n <= 12).length,
        "13+": areaCounts.filter((n) => n >= 13).length,
      },
    },
    optionalV1Estimate: {
      performed: true,
      complexesWithCandidate: withCand,
      estimatedSafeGroups: safeGroups,
      groupsWritten: 0,
    },
    coverageBefore,
    coverageAfter,
    coverageDelta: {
      complexes: `${coverageBefore.unitMasterComplexes} → ${coverageAfter.unitMasterComplexes}`,
      canonicalUnits: `${coverageBefore.unitMasterCanonicalIdentities} → ${coverageAfter.unitMasterCanonicalIdentities}`,
    },
    idempotency: {
      wouldInsert,
      wouldUpdate: 0,
      wouldDelete: 0,
      status: wouldInsert === 0 ? "PASS" : "HOLD",
    },
    performance: {
      selection: { ms: selectionMs, queries: selCounter.queries },
      manifest: { ms: manifestMs, queries: manCounter.queries },
      insert: { ms: insertMs, batchCalls },
      postcheck: { ms: postcheckMs, queries: postCounter.queries },
      totalMs,
      rowByRowDbOperation: "NO",
    },
    dataSafety: {
      ...dataSafety,
      status: dataSafetyPass ? "PASS" : "HOLD",
    },
    nextAction: { choice: nextAction, reason: nextReason },
    decision: {
      "250_COMPLEX_SELECTION":
        targets.length === TARGET_COUNT && eligibleCount >= TARGET_COUNT
          ? "PASS"
          : "HOLD",
      MANIFEST_PRECHECK: precheckPass ? "PASS" : "HOLD",
      REAL_BATCH_INSERT:
        promotionAttempted &&
        firstBatchSanity === "PASS" &&
        !insertResult?.stoppedEarly &&
        rowsInserted === expectedInserts &&
        integrity.present === expectedUnits
          ? "PASS"
          : "HOLD",
      CANONICAL_COMPLETENESS:
        incompleteComplexes === 0 && integrity.missing.length === 0
          ? "PASS"
          : "HOLD",
      NEW_CX_INTEGRITY:
        integrity.duplicateComplexArea === 0 &&
        integrity.duplicateUnitTypeKey === 0 &&
        newSlugWrites === 0
          ? "PASS"
          : "HOLD",
      IDEMPOTENCY: wouldInsert === 0 ? "PASS" : "HOLD",
      "500_COMPLEX_SCALE_READINESS": scaleReady ? "READY" : "NOT_READY",
      DATA_SAFETY: dataSafetyPass ? "PASS" : "HOLD",
    },
  };

  writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        out: { manifest: MANIFEST_OUT, report: REPORT_OUT },
        selected: targets.length,
        eligible: eligibleCount,
        expectedUnits,
        rowsInserted,
        batchCalls,
        firstBatchSanity,
        postcheckStatus,
        coverageBefore,
        coverageAfter,
        performance: report.performance,
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
