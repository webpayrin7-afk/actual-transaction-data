/**
 * Bounded unit-master promotion path helpers (Stage22/23).
 * Semantics frozen: trade-only, cx_, areaKey=ROUND*100/100, insert-missing only.
 * Performance: batch fetch + libsql db.batch (CHUNK=80, matches src/lib/db/repository.ts).
 */
import type { createClient, InArgs } from "@libsql/client";
import {
  areaKey,
  areaKeyStr,
  dedupeAreas,
  type AreaRow,
} from "./stage9-grouping-contract";

export type Db = ReturnType<typeof createClient>;

export const UNIT_INSERT_CHUNK = 80;
export const IN_CHUNK = 80;

export type UnitTarget = {
  complexId: string;
  aptNameNorm: string;
  lawdCd: string;
  aptName: string | null;
  tradeTxCount: number;
  canonicalAreaCount: number;
  areas: AreaRow[];
};

export type PlannedUnit = {
  unitTypeKey: string;
  complexKey: string;
  exclusiveArea: number;
};

export type QueryCounter = {
  queries: number;
  rows: number;
  networkCalls: number;
};

export function freshCounter(): QueryCounter {
  return { queries: 0, rows: 0, networkCalls: 0 };
}

async function trackedExecute(
  db: Db,
  counter: QueryCounter,
  sql: string,
  args: InArgs = [],
) {
  counter.queries += 1;
  counter.networkCalls += 1;
  const r = await db.execute({ sql, args });
  counter.rows += r.rows.length;
  return r;
}

export async function fetchExistingCxUnitKeys(
  db: Db,
  counter?: QueryCounter,
): Promise<Set<string>> {
  const c = counter ?? freshCounter();
  const r = await trackedExecute(
    db,
    c,
    `SELECT DISTINCT complex_key FROM apt_unit_types WHERE complex_key LIKE 'cx_%'`,
  );
  return new Set(r.rows.map((row) => String(row.complex_key)));
}

/** Ranking inventory: one aggregate query (no per-complex follow-up). */
export async function selectEligibleInventory(
  db: Db,
  opts: {
    minTradeTx: number;
    minAreas: number;
    maxAreas: number;
    exclude: Set<string>;
  },
  counter?: QueryCounter,
): Promise<
  Array<{
    complexId: string;
    aptNameNorm: string;
    lawdCd: string;
    aptName: string | null;
    tradeTxCount: number;
    canonicalAreaCount: number;
  }>
> {
  const c = counter ?? freshCounter();
  const r = await trackedExecute(
    db,
    c,
    `
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
    HAVING COUNT(*) >= ?
       AND COUNT(DISTINCT ROUND(t.exclusive_area * 100) / 100) >= ?
       AND COUNT(DISTINCT ROUND(t.exclusive_area * 100) / 100) <= ?
    ORDER BY COUNT(*) DESC, m.complex_id ASC
    `,
    [opts.minTradeTx, opts.minAreas, opts.maxAreas],
  );

  const out: Array<{
    complexId: string;
    aptNameNorm: string;
    lawdCd: string;
    aptName: string | null;
    tradeTxCount: number;
    canonicalAreaCount: number;
  }> = [];
  for (const row of r.rows) {
    const cid = String(row.complex_id);
    if (opts.exclude.has(cid)) continue;
    if (!cid.startsWith("cx_")) continue;
    out.push({
      complexId: cid,
      aptNameNorm: String(row.apt_name_norm),
      lawdCd: String(row.lawd_cd),
      aptName: row.apt_name != null ? String(row.apt_name) : null,
      tradeTxCount: Number(row.trade_tx),
      canonicalAreaCount: Number(row.area_n),
    });
  }
  return out;
}

/** Batch-load trade areas for selected complex IDs (chunked IN). */
export async function batchLoadTradeAreasByComplexIds(
  db: Db,
  complexIds: string[],
  counter?: QueryCounter,
): Promise<Map<string, AreaRow[]>> {
  const c = counter ?? freshCounter();
  const byId = new Map<string, AreaRow[]>();
  for (const id of complexIds) byId.set(id, []);

  for (let i = 0; i < complexIds.length; i += IN_CHUNK) {
    const chunk = complexIds.slice(i, i + IN_CHUNK);
    const ph = chunk.map(() => "?").join(",");
    const r = await trackedExecute(
      db,
      c,
      `
      SELECT m.complex_id AS complex_id,
             t.exclusive_area AS ea,
             COUNT(*) AS cnt
      FROM apt_complex_master m
      JOIN transactions t
        ON t.apt_name_norm = m.apt_name_norm AND t.lawd_cd = m.lawd_cd
      WHERE m.complex_id IN (${ph})
        AND t.deal_type = 'trade'
        AND t.exclusive_area IS NOT NULL
        AND t.exclusive_area > 0
      GROUP BY m.complex_id, t.exclusive_area
      `,
      chunk,
    );
    for (const row of r.rows) {
      const cid = String(row.complex_id);
      const list = byId.get(cid);
      if (!list) continue;
      list.push({
        exclusiveArea: Number(row.ea),
        txCount: Number(row.cnt),
      });
    }
  }

  for (const [cid, raw] of byId) {
    byId.set(cid, dedupeAreas(raw));
  }
  return byId;
}

export async function batchLoadMasterRows(
  db: Db,
  complexIds: string[],
  counter?: QueryCounter,
): Promise<
  Map<
    string,
    {
      complexId: string;
      identityStatus: string;
      sidoCode: string;
      aptNameNorm: string;
      lawdCd: string;
      aptName: string | null;
    }
  >
> {
  const c = counter ?? freshCounter();
  const map = new Map<
    string,
    {
      complexId: string;
      identityStatus: string;
      sidoCode: string;
      aptNameNorm: string;
      lawdCd: string;
      aptName: string | null;
    }
  >();
  for (let i = 0; i < complexIds.length; i += IN_CHUNK) {
    const chunk = complexIds.slice(i, i + IN_CHUNK);
    const ph = chunk.map(() => "?").join(",");
    const r = await trackedExecute(
      db,
      c,
      `SELECT complex_id, identity_status, sido_code, apt_name_norm, lawd_cd, apt_name
       FROM apt_complex_master WHERE complex_id IN (${ph})`,
      chunk,
    );
    for (const row of r.rows) {
      const cid = String(row.complex_id);
      map.set(cid, {
        complexId: cid,
        identityStatus: String(row.identity_status),
        sidoCode: String(row.sido_code),
        aptNameNorm: String(row.apt_name_norm),
        lawdCd: String(row.lawd_cd),
        aptName: row.apt_name != null ? String(row.apt_name) : null,
      });
    }
  }
  return map;
}

export async function batchLoadExistingUnits(
  db: Db,
  complexIds: string[],
  counter?: QueryCounter,
): Promise<
  Map<
    string,
    Array<{
      unitTypeKey: string;
      exclusiveAreaMin: number;
      exclusiveAreaMax: number;
    }>
  >
> {
  const c = counter ?? freshCounter();
  const map = new Map<
    string,
    Array<{
      unitTypeKey: string;
      exclusiveAreaMin: number;
      exclusiveAreaMax: number;
    }>
  >();
  for (const id of complexIds) map.set(id, []);

  for (let i = 0; i < complexIds.length; i += IN_CHUNK) {
    const chunk = complexIds.slice(i, i + IN_CHUNK);
    const ph = chunk.map(() => "?").join(",");
    const r = await trackedExecute(
      db,
      c,
      `SELECT unit_type_key, complex_key, exclusive_area_min, exclusive_area_max
       FROM apt_unit_types WHERE complex_key IN (${ph})`,
      chunk,
    );
    for (const row of r.rows) {
      const ck = String(row.complex_key);
      const list = map.get(ck);
      if (!list) continue;
      list.push({
        unitTypeKey: String(row.unit_type_key),
        exclusiveAreaMin: Number(row.exclusive_area_min),
        exclusiveAreaMax: Number(row.exclusive_area_max),
      });
    }
  }
  return map;
}

export function buildTargetsFromMeta(
  meta: Array<{
    complexId: string;
    aptNameNorm: string;
    lawdCd: string;
    aptName: string | null;
    tradeTxCount?: number;
    canonicalAreaCount?: number;
  }>,
  areasById: Map<string, AreaRow[]>,
): UnitTarget[] {
  return meta.map((m) => {
    const areas = areasById.get(m.complexId) ?? [];
    return {
      complexId: m.complexId,
      aptNameNorm: m.aptNameNorm,
      lawdCd: m.lawdCd,
      aptName: m.aptName,
      tradeTxCount: areas.reduce((s, a) => s + a.txCount, 0),
      canonicalAreaCount: areas.length,
      areas,
    };
  });
}

export function planUnits(targets: UnitTarget[]): PlannedUnit[] {
  const out: PlannedUnit[] = [];
  for (const t of targets) {
    for (const a of t.areas) {
      const ak = areaKey(a.exclusiveArea);
      out.push({
        unitTypeKey: `${t.complexId}:ex${areaKeyStr(ak)}`,
        complexKey: t.complexId,
        exclusiveArea: ak,
      });
    }
  }
  return out;
}

export function filterMissingUnits(
  planned: PlannedUnit[],
  existingByComplex: Map<
    string,
    Array<{ unitTypeKey: string; exclusiveAreaMin: number; exclusiveAreaMax: number }>
  >,
): PlannedUnit[] {
  const have = new Set<string>();
  for (const rows of existingByComplex.values()) {
    for (const u of rows) have.add(u.unitTypeKey);
  }
  return planned.filter((p) => !have.has(p.unitTypeKey));
}

export function insertStatements(missing: PlannedUnit[]) {
  return missing.map((p) => ({
    sql: `INSERT INTO apt_unit_types (
      unit_type_key, complex_key, supply_area_sqm,
      exclusive_area_min, exclusive_area_max,
      household_count, mapping_confidence,
      exclusive_includes_partial_common, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      p.unitTypeKey,
      p.complexKey,
      null,
      p.exclusiveArea,
      p.exclusiveArea,
      null,
      "transaction_raw_exclusive",
      0,
      "transactions",
    ] as InArgs,
  }));
}

/** Chunked libsql batch write. Returns network batch call count. */
export async function batchInsertUnits(
  db: Db,
  missing: PlannedUnit[],
  counter?: QueryCounter,
): Promise<{ inserted: number; batchCalls: number }> {
  const c = counter ?? freshCounter();
  const stmts = insertStatements(missing);
  let batchCalls = 0;
  for (let i = 0; i < stmts.length; i += UNIT_INSERT_CHUNK) {
    const chunk = stmts.slice(i, i + UNIT_INSERT_CHUNK);
    await db.batch(chunk, "write");
    batchCalls += 1;
    c.networkCalls += 1;
    c.queries += chunk.length; // statements in batch
  }
  return { inserted: missing.length, batchCalls };
}

export function expectedBatchCallsForRows(n: number): number {
  if (n <= 0) return 0;
  return Math.ceil(n / UNIT_INSERT_CHUNK);
}

export function compareManifestIdentities(
  expected: PlannedUnit[],
  existingByComplex: Map<
    string,
    Array<{ unitTypeKey: string; exclusiveAreaMin: number; exclusiveAreaMax: number }>
  >,
): {
  present: number;
  missing: string[];
  duplicateComplexArea: number;
  duplicateUnitTypeKey: number;
} {
  const haveKeys = new Set<string>();
  const areaCounts = new Map<string, number>();
  const utkCounts = new Map<string, number>();

  for (const [ck, rows] of existingByComplex) {
    for (const u of rows) {
      haveKeys.add(u.unitTypeKey);
      utkCounts.set(u.unitTypeKey, (utkCounts.get(u.unitTypeKey) ?? 0) + 1);
      if (areaKey(u.exclusiveAreaMin) !== areaKey(u.exclusiveAreaMax)) continue;
      const ak = `${ck}|${areaKeyStr(u.exclusiveAreaMin)}`;
      areaCounts.set(ak, (areaCounts.get(ak) ?? 0) + 1);
    }
  }

  const missing = expected
    .map((p) => p.unitTypeKey)
    .filter((k) => !haveKeys.has(k));
  const duplicateComplexArea = [...areaCounts.values()].filter((n) => n > 1).length;
  const duplicateUnitTypeKey = [...utkCounts.values()].filter((n) => n > 1).length;

  return {
    present: expected.length - missing.length,
    missing,
    duplicateComplexArea,
    duplicateUnitTypeKey,
  };
}

export const SELECTION_INVENTORY_SQL = `
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
HAVING COUNT(*) >= 50
   AND COUNT(DISTINCT ROUND(t.exclusive_area * 100) / 100) >= 2
   AND COUNT(DISTINCT ROUND(t.exclusive_area * 100) / 100) <= 20
ORDER BY COUNT(*) DESC, m.complex_id ASC
`;
