/**
 * National canonical unit-type + supply-area master.
 *
 * Reuses apt_unit_types, apt_pyeong_groups, and one grouped transaction scan.
 * Does not call building-registry or KAPT. Does not update existing positive supplies.
 * Does not rewrite ranking, price position, or apt_unit_types.
 *
 * Usage: ./node_modules/.bin/tsx scripts/region-ranking/build-national-unit-master.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient, type Client, type InArgs } from "@libsql/client";
import { precheckAdditiveCreateSql } from "../../src/lib/region-ranking/migration-precheck";
import {
  areaFromCents,
  canonicalSupplyPyeong,
  canonicalUnitTypeId,
  conflictId,
  exclusiveCents,
  NO_SUPPLY_CENTS,
  resolutionStatus,
  VERIFIED_SUPPLY_CONFIDENCE,
  type CanonicalUnitStatus,
} from "../../src/lib/unit-type/canonical";
import { supplyPyeongDisplayLabel } from "../../src/lib/unit-type/supply-label";

const AS_OF = "2026-09-17";
const START_12M = "2025-09-17";
const START_3Y = "2023-09-17";
const REPRESENTATIVE_EXACT_TRADE_SHARE = 0.8;
const BATCH = 40;
const MIGRATION = "src/lib/db/migrations/20260923_canonical_unit_types.sql";

const METRO: Record<string, string> = {
  "11": "서울",
  "41": "경기",
  "28": "인천",
  "26": "부산",
  "27": "대구",
  "30": "대전",
  // Current master uses 12 for 전남광주통합특별시. Prefix 29 is not present.
  "12": "광주",
  "31": "울산",
};

const PILOTS = [
  "잠실엘스",
  "파크리오",
  "리센츠",
  "헬리오시티",
  "반포자이",
  "래미안퍼스티지",
  "은마",
  "도곡렉슬",
  "마포프레스티지자이",
  "포레나노원",
];

const JAMSIL_ID = "cx_4c63d9a100973c60";
const JAMSIL_REQUIRED: Array<[number, number]> = [
  [8480, 11152],
  [8488, 10929],
  [8497, 10947],
];

type MasterRow = {
  complexId: string;
  aptName: string;
  aptNameNorm: string;
  sido: string;
  lawdCd: string;
  bjdongCd: string;
  jibun: string;
};

type PairObs = {
  tradeCount: number;
  c12: number;
  c3y: number;
  latest: string;
  fromTx: boolean;
  fromUnit: boolean;
  fromGroup: boolean;
};

type SupplyHit = {
  supplyCents: number;
  source: string;
  sourceKey: string;
  confidence: string;
  household: number | null;
  formula: string;
};

type HeldConflict = {
  complexId: string;
  exclusiveCents: number;
  heldSupplyCents: number;
  heldSource: string;
  heldSourceKey: string;
  reason: string;
};

type TradeTotals = { c12: number; c3y: number };

function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function pairKey(complexId: string, cents: number): string {
  return `${complexId}|${cents}`;
}

function prefixOf(lawdCd: string): string {
  return lawdCd.slice(0, 2);
}

function emptyPair(): PairObs {
  return { tradeCount: 0, c12: 0, c3y: 0, latest: "", fromTx: false, fromUnit: false, fromGroup: false };
}

function observedFrom(pair: PairObs): string {
  const parts: string[] = [];
  if (pair.fromTx) parts.push("transactions");
  if (pair.fromUnit) parts.push("unit_types");
  if (pair.fromGroup) parts.push("pyeong_groups");
  return parts.join("+") || "unknown";
}

async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      await fn(items[current]!);
    }
  }
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

async function batchWrite(db: Client, statements: { sql: string; args: InArgs }[]): Promise<number> {
  let affected = 0;
  for (let i = 0; i < statements.length; i += BATCH) {
    const slice = statements.slice(i, i + BATCH);
    const results = await db.batch(slice, "write");
    for (const result of results) affected += result.rowsAffected ?? 0;
  }
  return affected;
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });
  const now = new Date().toISOString();
  const sampleDate = await db.execute("SELECT deal_date FROM transactions WHERE deal_type = 'trade' LIMIT 1");
  const dealDate = str(sampleDate.rows[0]?.deal_date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dealDate)) {
    throw new Error(`unexpected deal_date shape: ${dealDate}`);
  }

  const masterRows = await db.execute(
    `SELECT complex_id, apt_name, apt_name_norm, sido, lawd_cd, bjdong_cd, jibun
     FROM apt_complex_master`,
  );
  const byId = new Map<string, MasterRow>();
  const byLawdNorm = new Map<string, MasterRow[]>();
  const lawds = new Set<string>();
  for (const row of masterRows.rows) {
    const item: MasterRow = {
      complexId: str(row.complex_id),
      aptName: str(row.apt_name),
      aptNameNorm: str(row.apt_name_norm),
      sido: str(row.sido),
      lawdCd: str(row.lawd_cd),
      bjdongCd: str(row.bjdong_cd),
      jibun: str(row.jibun),
    };
    byId.set(item.complexId, item);
    lawds.add(item.lawdCd);
    const key = `${item.lawdCd}|${item.aptNameNorm}`;
    const list = byLawdNorm.get(key);
    if (list) list.push(item);
    else byLawdNorm.set(key, [item]);
  }

  const classRows = await db.execute(
    `SELECT complex_key, complex_id, apt_name_norm, lawd_cd FROM apt_complex_classifications`,
  );
  const classByKey = new Map<string, { complexId: string; aptNameNorm: string; lawdCd: string }>();
  for (const row of classRows.rows) {
    classByKey.set(str(row.complex_key), {
      complexId: str(row.complex_id),
      aptNameNorm: str(row.apt_name_norm),
      lawdCd: str(row.lawd_cd),
    });
  }

  function resolveComplexId(complexKey: string): string | null {
    if (complexKey.startsWith("cx_") && byId.has(complexKey)) return complexKey;
    const classified = classByKey.get(complexKey);
    if (!classified) return null;
    if (classified.complexId && byId.has(classified.complexId)) return classified.complexId;
    const matches = byLawdNorm.get(`${classified.lawdCd}|${classified.aptNameNorm}`) ?? [];
    if (matches.length === 1) return matches[0]!.complexId;
    return null;
  }

  const pairs = new Map<string, PairObs>();
  const supplies = new Map<string, Map<number, SupplyHit>>();
  const conflicts: HeldConflict[] = [];
  const reuse = {
    verifiedUnitRows: 0,
    exposRows: 0,
    rawExclusiveRows: 0,
    unresolvedUnitKeys: 0,
    groupedOrAmbiguousHeld: 0,
    pyeongPointMatched: 0,
    pyeongPointHeld: 0,
    pyeongRangesIgnored: 0,
    orphanRaw: 0,
  };

  function observe(complexId: string, cents: number, source: "tx" | "unit" | "group"): PairObs {
    const key = pairKey(complexId, cents);
    let pair = pairs.get(key);
    if (!pair) {
      pair = emptyPair();
      pairs.set(key, pair);
    }
    if (source === "tx") pair.fromTx = true;
    if (source === "unit") pair.fromUnit = true;
    if (source === "group") pair.fromGroup = true;
    return pair;
  }

  function addVerified(complexId: string, exCents: number, hit: SupplyHit) {
    observe(complexId, exCents, "unit");
    const key = pairKey(complexId, exCents);
    let variants = supplies.get(key);
    if (!variants) {
      variants = new Map();
      supplies.set(key, variants);
    }
    if (!variants.has(hit.supplyCents)) variants.set(hit.supplyCents, hit);
  }

  const unitRows = await db.execute(
    `SELECT complex_key, unit_type_key, supply_area_sqm, exclusive_area_min, exclusive_area_max,
            household_count, mapping_confidence, exclusive_includes_partial_common, source
     FROM apt_unit_types`,
  );
  const deferredNonVerified: Array<{
    complexId: string;
    exCents: number;
    supplyCents: number;
    source: string;
    sourceKey: string;
    reason: string;
  }> = [];

  for (const row of unitRows.rows) {
    const complexKey = str(row.complex_key);
    const confidence = str(row.mapping_confidence);
    const exMin = num(row.exclusive_area_min);
    const exMax = num(row.exclusive_area_max);
    const minCents = exclusiveCents(exMin);
    const maxCents = exclusiveCents(exMax);
    if (minCents < 0 || minCents !== maxCents) continue;
    const complexId = resolveComplexId(complexKey);
    if (!complexId) {
      reuse.unresolvedUnitKeys += 1;
      continue;
    }
    if (confidence === "transaction_raw_exclusive") {
      observe(complexId, minCents, "unit");
      reuse.rawExclusiveRows += 1;
      continue;
    }
    const supply = num(row.supply_area_sqm);
    const supplyCents = exclusiveCents(supply);
    const partial = num(row.exclusive_includes_partial_common) !== 0;
    const verified = VERIFIED_SUPPLY_CONFIDENCE.has(confidence) && supplyCents > 0 && !partial;
    if (verified) {
      addVerified(complexId, minCents, {
        supplyCents,
        source: str(row.source),
        sourceKey: str(row.unit_type_key),
        confidence,
        household: row.household_count == null ? null : num(row.household_count),
        formula: confidence === "building_registry_expos" ? "exclusive_plus_residential_common" : "recorded_supply_area",
      });
      reuse.verifiedUnitRows += 1;
      if (confidence === "building_registry_expos") reuse.exposRows += 1;
      continue;
    }
    if ((confidence === "grouped" || confidence === "ambiguous") && supplyCents > 0) {
      deferredNonVerified.push({
        complexId,
        exCents: minCents,
        supplyCents,
        source: str(row.source),
        sourceKey: str(row.unit_type_key),
        reason: confidence === "grouped" ? "GROUPED_DIFFERS_FROM_VERIFIED" : "AMBIGUOUS_DIFFERS_FROM_VERIFIED",
      });
    }
  }

  for (const held of deferredNonVerified) {
    const variants = supplies.get(pairKey(held.complexId, held.exCents));
    if (!variants || variants.size === 0) continue;
    if (variants.has(held.supplyCents)) continue;
    conflicts.push({
      complexId: held.complexId,
      exclusiveCents: held.exCents,
      heldSupplyCents: held.supplyCents,
      heldSource: held.source,
      heldSourceKey: held.sourceKey,
      reason: held.reason,
    });
    reuse.groupedOrAmbiguousHeld += 1;
  }

  const groupRows = await db.execute(
    `SELECT complex_key, group_key, confidence, exclusive_area_min, exclusive_area_max,
            supply_area_min, supply_area_max, source
     FROM apt_pyeong_groups`,
  );
  for (const row of groupRows.rows) {
    const exMin = exclusiveCents(num(row.exclusive_area_min));
    const exMax = exclusiveCents(num(row.exclusive_area_max));
    const suMin = exclusiveCents(num(row.supply_area_min));
    const suMax = exclusiveCents(num(row.supply_area_max));
    if (exMin < 0 || exMin !== exMax || suMin < 0 || suMin !== suMax) {
      reuse.pyeongRangesIgnored += 1;
      continue;
    }
    const complexId = resolveComplexId(str(row.complex_key));
    if (!complexId) continue;
    observe(complexId, exMin, "group");
    const variants = supplies.get(pairKey(complexId, exMin));
    if (variants?.has(suMin)) {
      reuse.pyeongPointMatched += 1;
      continue;
    }
    if (variants && variants.size > 0 && str(row.confidence) === "exact") {
      conflicts.push({
        complexId,
        exclusiveCents: exMin,
        heldSupplyCents: suMin,
        heldSource: str(row.source),
        heldSourceKey: str(row.group_key),
        reason: "PYEONG_GROUP_DIFFERS_FROM_VERIFIED",
      });
      reuse.pyeongPointHeld += 1;
    }
  }

  function suppliesFor(complexId: string, cents: number): Map<number, SupplyHit> | undefined {
    return supplies.get(pairKey(complexId, cents));
  }

  function assertJamsil() {
    for (const [ex, su] of JAMSIL_REQUIRED) {
      const variants = suppliesFor(JAMSIL_ID, ex);
      const status = resolutionStatus(variants?.size ?? 0, false);
      if (status !== "EXACT_SINGLE" || !variants?.has(su) || variants.size !== 1) {
        throw new Error(`jamsil map failed ${ex} -> ${su} status=${status} size=${variants?.size ?? 0}`);
      }
    }
    const fiftyNine = suppliesFor(JAMSIL_ID, 5996);
    if (resolutionStatus(fiftyNine?.size ?? 0, false) !== "AMBIGUOUS_MULTI" || (fiftyNine?.size ?? 0) < 2) {
      throw new Error("jamsil 59.96 variants collapsed or missing");
    }
  }
  assertJamsil();

  const tradeTotals = new Map<string, TradeTotals>();
  function addTradeTotal(lawdCd: string, c12: number, c3y: number) {
    const prefix = prefixOf(lawdCd);
    const current = tradeTotals.get(prefix) ?? { c12: 0, c3y: 0 };
    current.c12 += c12;
    current.c3y += c3y;
    tradeTotals.set(prefix, current);
  }

  const lawdList = [...lawds].sort();
  let scanned = 0;
  const started = Date.now();
  await mapPool(lawdList, 4, async (lawd) => {
    const grouped = await db.execute({
      sql: `SELECT apt_name_norm AS name,
                   CAST(ROUND(exclusive_area * 100) AS INTEGER) AS cents,
                   COUNT(*) AS c,
                   MAX(deal_date) AS latest,
                   SUM(CASE WHEN deal_date > ? AND deal_date <= ? THEN 1 ELSE 0 END) AS c12,
                   SUM(CASE WHEN deal_date > ? AND deal_date <= ? THEN 1 ELSE 0 END) AS c3y
            FROM transactions
            WHERE lawd_cd = ?
              AND deal_type = 'trade'
              AND exclusive_area > 0
              AND deal_amount > 0
            GROUP BY apt_name_norm, CAST(ROUND(exclusive_area * 100) AS INTEGER)`,
      args: [START_12M, AS_OF, START_3Y, AS_OF, lawd],
    });
    for (const row of grouped.rows) {
      const cents = num(row.cents);
      const c12 = num(row.c12);
      const c3y = num(row.c3y);
      addTradeTotal(lawd, c12, c3y);
      if (cents <= 0) continue;
      const matches = byLawdNorm.get(`${lawd}|${str(row.name)}`);
      if (!matches || matches.length !== 1) continue;
      const pair = observe(matches[0]!.complexId, cents, "tx");
      pair.tradeCount += num(row.c);
      pair.c12 += c12;
      pair.c3y += c3y;
      const latest = str(row.latest);
      if (latest > pair.latest) pair.latest = latest;
    }
    scanned += 1;
    if (scanned % 25 === 0 || scanned === lawdList.length) {
      console.log(`scan ${scanned}/${lawdList.length} pairs=${pairs.size} elapsed=${Math.round((Date.now() - started) / 1000)}s`);
    }
  });

  const kapt = await db.execute(
    `SELECT complex_id, source_key FROM apt_complex_source_links WHERE source = 'KAPT'`,
  );
  const kaptByComplex = new Map<string, string>();
  for (const row of kapt.rows) {
    const id = str(row.complex_id);
    if (!kaptByComplex.has(id)) kaptByComplex.set(id, str(row.source_key));
  }

  type PlannedType = {
    unitTypeId: string;
    complexId: string;
    exclusiveArea: number;
    exclusiveCents: number;
    supplyArea: number | null;
    supplyCents: number;
    supplyPyeong: number | null;
    displayLabel: string | null;
    household: number | null;
    source: string;
    sourceKey: string;
    confidence: string;
    status: CanonicalUnitStatus;
    formula: string;
  };
  const plannedTypes: PlannedType[] = [];
  const plannedPairs: Array<{
    complexId: string;
    exclusiveCents: number;
    exclusiveArea: number;
    tradeCount: number;
    c12: number;
    c3y: number;
    latest: string;
    status: CanonicalUnitStatus;
    variants: number;
    observedFrom: string;
  }> = [];

  const statusCounts: Record<CanonicalUnitStatus, number> = {
    EXACT_SINGLE: 0,
    EXACT_MULTI_RESOLVABLE: 0,
    AMBIGUOUS_MULTI: 0,
    NO_SOURCE: 0,
  };
  const complexesWithSupply = new Set<string>();
  const complexesWithExact = new Set<string>();
  const pairStats = new Map<string, { pairs: number; exact: number; ambiguous: number; noSource: number; exact12: number; exact3y: number }>();

  function regionStats(lawdCd: string) {
    const prefix = prefixOf(lawdCd);
    let stats = pairStats.get(prefix);
    if (!stats) {
      stats = { pairs: 0, exact: 0, ambiguous: 0, noSource: 0, exact12: 0, exact3y: 0 };
      pairStats.set(prefix, stats);
    }
    return stats;
  }

  for (const [key, pair] of pairs) {
    const splitAt = key.lastIndexOf("|");
    const complexId = key.slice(0, splitAt);
    const cents = Number(key.slice(splitAt + 1));
    const master = byId.get(complexId);
    if (!master || cents <= 0) continue;
    const variants = supplies.get(key);
    const status = resolutionStatus(variants?.size ?? 0, false);
    statusCounts[status] += 1;
    const stats = regionStats(master.lawdCd);
    stats.pairs += 1;
    if (status === "EXACT_SINGLE" || status === "EXACT_MULTI_RESOLVABLE") {
      stats.exact += 1;
      stats.exact12 += pair.c12;
      stats.exact3y += pair.c3y;
      complexesWithExact.add(complexId);
    } else if (status === "AMBIGUOUS_MULTI") stats.ambiguous += 1;
    else stats.noSource += 1;

    const exclusiveArea = areaFromCents(cents);
    if (!variants || variants.size === 0) {
      plannedTypes.push({
        unitTypeId: canonicalUnitTypeId(complexId, cents, NO_SUPPLY_CENTS),
        complexId,
        exclusiveArea,
        exclusiveCents: cents,
        supplyArea: null,
        supplyCents: NO_SUPPLY_CENTS,
        supplyPyeong: null,
        displayLabel: null,
        household: null,
        source: "observed_exclusive",
        sourceKey: "",
        confidence: "none",
        status,
        formula: "none",
      });
    } else {
      complexesWithSupply.add(complexId);
      for (const hit of variants.values()) {
        const supplyArea = areaFromCents(hit.supplyCents);
        plannedTypes.push({
          unitTypeId: canonicalUnitTypeId(complexId, cents, hit.supplyCents),
          complexId,
          exclusiveArea,
          exclusiveCents: cents,
          supplyArea,
          supplyCents: hit.supplyCents,
          supplyPyeong: canonicalSupplyPyeong(supplyArea),
          displayLabel: supplyPyeongDisplayLabel(supplyArea),
          household: hit.household,
          source: hit.source,
          sourceKey: hit.sourceKey,
          confidence: hit.confidence,
          status,
          formula: hit.formula,
        });
      }
    }
    plannedPairs.push({
      complexId,
      exclusiveCents: cents,
      exclusiveArea,
      tradeCount: pair.tradeCount,
      c12: pair.c12,
      c3y: pair.c3y,
      latest: pair.latest,
      status,
      variants: variants?.size ?? 0,
      observedFrom: observedFrom(pair),
    });
  }

  const manifest: Array<{
    complexId: string;
    sido: string;
    lawdCd: string;
    bjdongCd: string;
    aptName: string;
    jibun: string;
    kaptCode: string;
    unresolved: number;
    noSource: number;
    ambiguous: number;
    blocker: string;
  }> = [];
  const pairCountsByComplex = new Map<string, { noSource: number; ambiguous: number }>();
  for (const pair of plannedPairs) {
    const current = pairCountsByComplex.get(pair.complexId) ?? { noSource: 0, ambiguous: 0 };
    if (pair.status === "NO_SOURCE") current.noSource += 1;
    if (pair.status === "AMBIGUOUS_MULTI") current.ambiguous += 1;
    pairCountsByComplex.set(pair.complexId, current);
  }
  let noObservedComplexes = 0;
  for (const master of byId.values()) {
    const counts = pairCountsByComplex.get(master.complexId);
    if (!counts) {
      noObservedComplexes += 1;
      manifest.push({
        complexId: master.complexId,
        sido: master.sido,
        lawdCd: master.lawdCd,
        bjdongCd: master.bjdongCd,
        aptName: master.aptName,
        jibun: master.jibun,
        kaptCode: kaptByComplex.get(master.complexId) ?? "",
        unresolved: 0,
        noSource: 0,
        ambiguous: 0,
        blocker: "NO_OBSERVED_EXCLUSIVE",
      });
      continue;
    }
    if (counts.noSource > 0) {
      manifest.push({
        complexId: master.complexId,
        sido: master.sido,
        lawdCd: master.lawdCd,
        bjdongCd: master.bjdongCd,
        aptName: master.aptName,
        jibun: master.jibun,
        kaptCode: kaptByComplex.get(master.complexId) ?? "",
        unresolved: counts.noSource,
        noSource: counts.noSource,
        ambiguous: counts.ambiguous,
        blocker: "NO_OFFICIAL_EXPOS_CACHE",
      });
    }
  }

  const migrationSql = readFileSync(MIGRATION, "utf8");
  const precheck = precheckAdditiveCreateSql(migrationSql);
  if (!precheck.ok) throw new Error(precheck.reason);
  for (const statement of precheck.statements) await db.execute(statement);

  const typeSql = `INSERT INTO apt_canonical_unit_types (
      unit_type_id, complex_id, exclusive_area, exclusive_cents, supply_area, supply_cents,
      supply_pyeong, display_pyeong_label, type_name, household_count, source, source_key,
      source_as_of, confidence, status, formula, provenance_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(unit_type_id) DO NOTHING`;
  const pairSql = `INSERT INTO apt_unit_exclusive_pairs (
      complex_id, exclusive_cents, exclusive_area, trade_count, trade_count_12m, trade_count_3y,
      latest_trade_date, resolution_status, supply_variant_count, observed_from
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(complex_id, exclusive_cents) DO NOTHING`;
  const conflictSql = `INSERT INTO apt_unit_supply_conflicts (
      conflict_id, complex_id, exclusive_cents, held_supply_area, held_supply_cents,
      held_source, held_source_key, reason, provenance_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conflict_id) DO NOTHING`;
  const manifestSql = `INSERT INTO apt_unit_acquisition_manifest (
      complex_id, sido, lawd_cd, bjdong_cd, apt_name, jibun, kapt_code,
      unresolved_pair_count, no_source_pair_count, ambiguous_pair_count, blocker_class, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(complex_id) DO NOTHING`;

  function typeStatements() {
    return plannedTypes.map((row) => ({
      sql: typeSql,
      args: [
        row.unitTypeId,
        row.complexId,
        row.exclusiveArea,
        row.exclusiveCents,
        row.supplyArea,
        row.supplyCents,
        row.supplyPyeong,
        row.displayLabel,
        null,
        row.household,
        row.source,
        row.sourceKey,
        "",
        row.confidence,
        row.status,
        row.formula,
        JSON.stringify({
          formula: row.formula,
          source_key: row.sourceKey,
          confidence: row.confidence,
        }),
        now,
        now,
      ] as InArgs,
    }));
  }
  function pairStatements() {
    return plannedPairs.map((row) => ({
      sql: pairSql,
      args: [
        row.complexId,
        row.exclusiveCents,
        row.exclusiveArea,
        row.tradeCount,
        row.c12,
        row.c3y,
        row.latest,
        row.status,
        row.variants,
        row.observedFrom,
      ] as InArgs,
    }));
  }
  function conflictStatements() {
    return conflicts.map((row) => ({
      sql: conflictSql,
      args: [
        conflictId(row.complexId, row.exclusiveCents, row.heldSupplyCents, row.heldSourceKey),
        row.complexId,
        row.exclusiveCents,
        areaFromCents(row.heldSupplyCents),
        row.heldSupplyCents,
        row.heldSource,
        row.heldSourceKey,
        row.reason,
        JSON.stringify({ reason: row.reason, held_supply_cents: row.heldSupplyCents }),
        now,
      ] as InArgs,
    }));
  }
  function manifestStatements() {
    return manifest.map((row) => ({
      sql: manifestSql,
      args: [
        row.complexId,
        row.sido,
        row.lawdCd,
        row.bjdongCd,
        row.aptName,
        row.jibun,
        row.kaptCode,
        row.unresolved,
        row.noSource,
        row.ambiguous,
        row.blocker,
        now,
      ] as InArgs,
    }));
  }

  console.log(
    `plan types=${plannedTypes.length} pairs=${plannedPairs.length} conflicts=${conflicts.length} manifest=${manifest.length}`,
  );
  const inserted = {
    types: await batchWrite(db, typeStatements()),
    pairs: await batchWrite(db, pairStatements()),
    conflicts: await batchWrite(db, conflictStatements()),
    manifest: await batchWrite(db, manifestStatements()),
  };
  const rerun = {
    types: await batchWrite(db, typeStatements()),
    pairs: await batchWrite(db, pairStatements()),
    conflicts: await batchWrite(db, conflictStatements()),
    manifest: await batchWrite(db, manifestStatements()),
  };

  const duplicate = await db.execute(
    `SELECT COUNT(*) AS c FROM (
       SELECT complex_id, exclusive_cents, supply_cents
       FROM apt_canonical_unit_types
       GROUP BY complex_id, exclusive_cents, supply_cents
       HAVING COUNT(*) > 1
     )`,
  );
  const duplicateCount = num(duplicate.rows[0]?.c);
  const storedJamsil = await db.execute({
    sql: `SELECT exclusive_cents, supply_cents, supply_area, supply_pyeong, display_pyeong_label, status
          FROM apt_canonical_unit_types
          WHERE complex_id = ?
          ORDER BY exclusive_cents, supply_cents`,
    args: [JAMSIL_ID],
  });

  const masterByPrefix = new Map<string, number>();
  const exactByPrefix = new Map<string, number>();
  const supplyByPrefix = new Map<string, number>();
  const otherSido = new Map<string, { complexes: number; exactComplexes: number; supplyComplexes: number }>();
  for (const master of byId.values()) {
    const prefix = prefixOf(master.lawdCd);
    masterByPrefix.set(prefix, (masterByPrefix.get(prefix) ?? 0) + 1);
    if (!METRO[prefix]) {
      const bucket = otherSido.get(master.sido) ?? { complexes: 0, exactComplexes: 0, supplyComplexes: 0 };
      bucket.complexes += 1;
      if (complexesWithExact.has(master.complexId)) bucket.exactComplexes += 1;
      if (complexesWithSupply.has(master.complexId)) bucket.supplyComplexes += 1;
      otherSido.set(master.sido, bucket);
    }
    if (complexesWithExact.has(master.complexId)) exactByPrefix.set(prefix, (exactByPrefix.get(prefix) ?? 0) + 1);
    if (complexesWithSupply.has(master.complexId)) supplyByPrefix.set(prefix, (supplyByPrefix.get(prefix) ?? 0) + 1);
  }

  function pct(part: number, whole: number): number {
    if (whole <= 0) return 0;
    return Math.round((part / whole) * 10000) / 100;
  }

  function regionReport(prefix: string) {
    const stats = pairStats.get(prefix) ?? { pairs: 0, exact: 0, ambiguous: 0, noSource: 0, exact12: 0, exact3y: 0 };
    const trades = tradeTotals.get(prefix) ?? { c12: 0, c3y: 0 };
    const complexes = masterByPrefix.get(prefix) ?? 0;
    const exactComplexes = exactByPrefix.get(prefix) ?? 0;
    return {
      complexes,
      exactComplexes,
      exactComplexCoverage: pct(exactComplexes, complexes),
      supplyComplexes: supplyByPrefix.get(prefix) ?? 0,
      pairs: stats.pairs,
      pairCoverage: pct(stats.exact, stats.pairs),
      trade12: pct(stats.exact12, trades.c12),
      trade3y: pct(stats.exact3y, trades.c3y),
      ambiguous: stats.ambiguous,
      noSource: stats.noSource,
      exact12: stats.exact12,
      total12: trades.c12,
      exact3y: stats.exact3y,
      total3y: trades.c3y,
    };
  }

  let nationalExact12 = 0;
  let nationalExact3y = 0;
  let nationalTotal12 = 0;
  let nationalTotal3y = 0;
  let nationalPairs = 0;
  let nationalExactPairs = 0;
  for (const [prefix, stats] of pairStats) {
    nationalPairs += stats.pairs;
    nationalExactPairs += stats.exact;
    nationalExact12 += stats.exact12;
    nationalExact3y += stats.exact3y;
    const trades = tradeTotals.get(prefix);
    if (trades) {
      nationalTotal12 += trades.c12;
      nationalTotal3y += trades.c3y;
    }
  }
  for (const [prefix, trades] of tradeTotals) {
    if (!pairStats.has(prefix)) {
      nationalTotal12 += trades.c12;
      nationalTotal3y += trades.c3y;
    }
  }

  const seoul = regionReport("11");
  const seoulSufficient = seoul.total12 > 0 && seoul.exact12 / seoul.total12 >= REPRESENTATIVE_EXACT_TRADE_SHARE;

  const pilots: Record<string, unknown> = {};
  for (const name of PILOTS) {
    const matches = [...byId.values()].filter((row) => row.aptNameNorm === name);
    pilots[name] = matches.map((master) => {
      const rows = plannedTypes.filter((row) => row.complexId === master.complexId && row.supplyCents !== NO_SUPPLY_CENTS);
      const pairRows = plannedPairs.filter((row) => row.complexId === master.complexId);
      const exact = pairRows.filter((row) => row.status === "EXACT_SINGLE").length;
      return {
        complexId: master.complexId,
        lawdCd: master.lawdCd,
        sido: master.sido,
        supplyTypes: rows.length,
        pairs: pairRows.length,
        exactPairs: exact,
        ambiguousPairs: pairRows.filter((row) => row.status === "AMBIGUOUS_MULTI").length,
        noSourcePairs: pairRows.filter((row) => row.status === "NO_SOURCE").length,
        supplies: rows.map((row) => ({
          exclusive: row.exclusiveArea,
          supply: row.supplyArea,
          pyeong: row.supplyPyeong,
          label: row.displayLabel,
          status: row.status,
        })),
      };
    });
  }

  const report = {
    masterComplexes: byId.size,
    targetComplexes: pairCountsByComplex.size,
    targetPairs: plannedPairs.length,
    canonicalUnitTypes: plannedTypes.length,
    reuse,
    resolution: statusCounts,
    conflicts: conflicts.length,
    production: {
      inserted,
      rerun,
      duplicateUnitTypes: duplicateCount,
      overwrittenPositiveValues: 0,
    },
    coverage: {
      complex: pct(complexesWithSupply.size, byId.size),
      supplyComplexes: complexesWithSupply.size,
      pair: pct(nationalExactPairs, nationalPairs),
      trade12: pct(nationalExact12, nationalTotal12),
      trade3y: pct(nationalExact3y, nationalTotal3y),
      ambiguityShare: pct(statusCounts.AMBIGUOUS_MULTI, nationalPairs),
      nationalExact12,
      nationalTotal12,
      nationalExact3y,
      nationalTotal3y,
    },
    regions: {
      서울: seoul,
      경기: regionReport("41"),
      인천: regionReport("28"),
      부산: regionReport("26"),
      대구: regionReport("27"),
      대전: regionReport("30"),
      광주: regionReport("29"),
      울산: regionReport("31"),
      otherSido: [...otherSido.entries()].map(([sido, stats]) => ({ sido, ...stats })),
    },
    pilots,
    selector: {
      readyComplexes: complexesWithExact.size,
      fallbackRemaining: byId.size - complexesWithExact.size,
      ready: complexesWithExact.size > 0,
    },
    pricePositionV2: {
      seoulCoverageSufficient: seoulSufficient,
      materializationCreated: false,
      apiSwitched: false,
      v1Preserved: true,
      publicSafe: false,
    },
    floorplan: {
      canonicalUnitTypeIdReady: true,
      providerMappingReady: false,
    },
    remaining: {
      noSourcePairs: statusCounts.NO_SOURCE,
      noObservedComplexes,
      manifestRows: manifest.length,
      blockerClasses: ["NO_OFFICIAL_EXPOS_CACHE", "NO_OBSERVED_EXCLUSIVE"],
      acquisitionManifest: true,
    },
    jamsilStored: storedJamsil.rows,
    newOfficialResolution: 0,
  };

  writeFileSync("/tmp/unit-master-report.json", JSON.stringify(report));
  console.log(JSON.stringify({
    master: report.masterComplexes,
    pairs: report.targetPairs,
    types: report.canonicalUnitTypes,
    inserted: report.production.inserted,
    rerun: report.production.rerun,
    duplicates: duplicateCount,
    seoulTrade12: seoul.trade12,
    seoulSufficient,
    conflicts: conflicts.length,
    noSource: statusCounts.NO_SOURCE,
  }));
  if (rerun.types !== 0 || rerun.pairs !== 0 || rerun.conflicts !== 0 || rerun.manifest !== 0) {
    throw new Error(`idempotent rerun wrote rows ${JSON.stringify(rerun)}`);
  }
  if (duplicateCount !== 0) throw new Error(`duplicate unit types ${duplicateCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
