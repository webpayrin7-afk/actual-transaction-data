/**
 * Apply compact resolvers + cohort classes, then recompute Seoul coverage.
 * Does not call the official API. Does not overwrite positive supplies.
 */
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createClient, type Client, type InArgs } from "@libsql/client";
import { readFileSync } from "node:fs";
import { precheckAdditiveCreateSql } from "../../src/lib/region-ranking/migration-precheck";
import { canonicalSupplyPyeong, exclusiveCents } from "../../src/lib/unit-type/canonical";
import { seoulLawdCodes } from "../../src/lib/region-ranking/price-position-read";

const FACTOR = 3.305785;
const BATCH = 80;
const SOURCE_VERSION = "mart_djy_06|2026-08|floor-shard-v1";

function num(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}
function decade(supplyArea: number): number {
  const py = supplyArea / FACTOR;
  return Math.floor(py / 10) * 10;
}
function cohortLabel(d: number): string {
  return d >= 10 ? `${d}평대` : "";
}

async function batchWrite(db: Client, statements: { sql: string; args: InArgs }[]) {
  for (let i = 0; i < statements.length; i += BATCH) {
    let last: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await db.batch(statements.slice(i, i + BATCH), "write");
        last = null;
        break;
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    if (last) throw last;
  }
}

type FloorRes = { supplyCents: number; supplyArea: number; supplyPyeong: number };

async function loadFloor(path: string): Promise<Map<string, FloorRes>> {
  const map = new Map<string, FloorRes>();
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const row = JSON.parse(line) as {
      complexId: string;
      exclusiveCents: number;
      buildingDong: string;
      floor: string;
      supplyCents: number;
      level: string;
    };
    if (row.level !== "EXACT_FLOOR" || row.buildingDong) continue;
    const supplyArea = row.supplyCents / 100;
    map.set(`${row.complexId}|${row.exclusiveCents}|${row.floor}`, {
      supplyCents: row.supplyCents,
      supplyArea,
      supplyPyeong: canonicalSupplyPyeong(supplyArea),
    });
  }
  return map;
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });
  const sql = readFileSync("src/lib/db/migrations/20260925_supply_resolvers.sql", "utf8");
  const pre = precheckAdditiveCreateSql(sql);
  if (!pre.ok) throw new Error(pre.reason);
  for (const statement of pre.statements) await db.execute(statement);

  console.log("loading floor resolvers…");
  const floor = await loadFloor("/tmp/building-hub-bulk/external-evidence/floor-resolvers.jsonl");
  console.log(JSON.stringify({ exactFloorKeys: floor.size }));

  const amb = await db.execute(`
    SELECT complex_id, exclusive_cents, supply_area, supply_cents
    FROM apt_canonical_unit_types
    WHERE status='AMBIGUOUS_MULTI' AND supply_cents >= 0
  `);
  const byPair = new Map<string, number[]>();
  for (const row of amb.rows) {
    const key = `${row.complex_id}|${num(row.exclusive_cents)}`;
    const list = byPair.get(key) ?? [];
    list.push(num(row.supply_area));
    byPair.set(key, list);
  }
  const cohort = new Map<string, { status: string; label: string; n: number }>();
  let safePairs = 0;
  let crossPairs = 0;
  const now = new Date().toISOString();
  let statements: { sql: string; args: InArgs }[] = [];
  const flush = async () => {
    if (!statements.length) return;
    const chunk = statements;
    statements = [];
    await batchWrite(db, chunk);
  };
  for (const [key, supplies] of byPair) {
    const [cid, ex] = key.split("|");
    const decades = new Set(supplies.map(decade));
    const status = decades.size === 1 ? "COHORT_SAFE_MULTI" : "COHORT_AMBIGUOUS";
    const label = decades.size === 1 ? cohortLabel([...decades][0]!) : "";
    if (status === "COHORT_SAFE_MULTI") safePairs += 1;
    else crossPairs += 1;
    cohort.set(key, { status, label, n: supplies.length });
    statements.push({
      sql: `INSERT INTO apt_exclusive_pair_cohort
              (complex_id, exclusive_cents, cohort_status, cohort_label, variant_count)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(complex_id, exclusive_cents) DO UPDATE SET
              cohort_status=excluded.cohort_status,
              cohort_label=excluded.cohort_label,
              variant_count=excluded.variant_count`,
      args: [cid, Number(ex), status, label, supplies.length],
    });
    if (statements.length >= 800) await flush();
  }
  await flush();
  console.log(JSON.stringify({ cohortPairs: byPair.size, safePairs, crossPairs }));

  const exactPairs = new Set<string>();
  const exactSupply = new Map<string, number>();
  const exactRows = await db.execute(`
    SELECT complex_id, exclusive_cents, supply_area
    FROM apt_canonical_unit_types
    WHERE status='EXACT_SINGLE' AND supply_cents >= 0
  `);
  for (const row of exactRows.rows) {
    const key = `${row.complex_id}|${num(row.exclusive_cents)}`;
    exactPairs.add(key);
    exactSupply.set(key, num(row.supply_area));
  }

  const ambPairs = new Set<string>(byPair.keys());

  const lawds = seoulLawdCodes();
  const masters = await db.execute({
    sql: `SELECT complex_id, lawd_cd, apt_name_norm FROM apt_complex_master
          WHERE lawd_cd IN (${lawds.map(() => "?").join(",")})`,
    args: lawds,
  });
  const byName = new Map<string, string>();
  const ambiguousName = new Set<string>();
  const seen = new Map<string, number>();
  for (const row of masters.rows) {
    const k = `${row.lawd_cd}|${row.apt_name_norm}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
    byName.set(k, String(row.complex_id));
  }
  for (const [k, n] of seen) if (n > 1) ambiguousName.add(k);

  type Bucket = {
    total: number;
    exactPair: number;
    exactFloor: number;
    dongFloor: number;
    cohortSafe: number;
    cohortAmb: number;
    noSource: number;
    unresolvedAmb: number;
  };
  const empty = (): Bucket => ({
    total: 0, exactPair: 0, exactFloor: 0, dongFloor: 0, cohortSafe: 0, cohortAmb: 0, noSource: 0, unresolvedAmb: 0,
  });
  const all = empty();
  const byCohort: Record<string, Bucket> = { "20평대": empty(), "30평대": empty(), "40평대": empty(), other: empty() };
  const usedResolvers = new Map<string, FloorRes & { complexId: string; exclusiveCents: number; floor: string }>();

  function add(b: Bucket, field: keyof Bucket) {
    b.total += 1;
    b[field] += 1;
  }

  for (const lawd of lawds) {
    const rows = await db.execute({
      sql: `SELECT apt_name_norm, exclusive_area, floor, deal_date
            FROM transactions
            WHERE lawd_cd=? AND deal_type='trade' AND deal_amount>0 AND exclusive_area>0
              AND deal_date>='2025-09-17' AND deal_date<='2026-09-17'`,
      args: [lawd],
    });
    for (const row of rows.rows) {
      const nameKey = `${lawd}|${row.apt_name_norm}`;
      if (ambiguousName.has(nameKey)) continue;
      const cid = byName.get(nameKey);
      if (!cid) continue;
      const ex = exclusiveCents(num(row.exclusive_area));
      const floorKey = `${cid}|${ex}|${num(row.floor)}`;
      const pairKey = `${cid}|${ex}`;
      let field: keyof Bucket = "noSource";
      let label = "other";
      if (exactPairs.has(pairKey)) {
        field = "exactPair";
        const supply = exactSupply.get(pairKey);
        if (supply) label = cohortLabel(decade(supply)) || "other";
      } else if (floor.has(floorKey)) {
        field = "exactFloor";
        const hit = floor.get(floorKey)!;
        label = cohortLabel(decade(hit.supplyArea)) || "other";
        usedResolvers.set(floorKey, { ...hit, complexId: cid, exclusiveCents: ex, floor: String(num(row.floor)) });
      } else if (ambPairs.has(pairKey)) {
        const c = cohort.get(pairKey);
        if (c?.status === "COHORT_SAFE_MULTI") {
          field = "cohortSafe";
          label = c.label || "other";
        } else {
          field = "cohortAmb";
        }
      }
      add(all, field);
      const dest = byCohort[label] ?? byCohort.other!;
      add(dest, field);
    }
    console.log(JSON.stringify({ lawd, runningTotal: all.total, exactFloor: all.exactFloor, cohortSafe: all.cohortSafe }));
  }

  for (const row of usedResolvers.values()) {
    statements.push({
      sql: `INSERT INTO transaction_supply_resolvers (
              complex_id, exclusive_cents, building_dong, floor, supply_cents, supply_area, supply_pyeong,
              resolver_level, source, source_version, status
            ) VALUES (?, ?, '', ?, ?, ?, ?, 'EXACT_FLOOR', 'BuildingHubBulkShard', ?, 'EXACT_FLOOR')
            ON CONFLICT(complex_id, exclusive_cents, building_dong, floor) DO NOTHING`,
      args: [row.complexId, row.exclusiveCents, row.floor, row.supplyCents, row.supplyArea, row.supplyPyeong, SOURCE_VERSION],
    });
    if (statements.length >= 800) await flush();
  }
  await flush();

  const conflicts = await db.execute(`SELECT COUNT(*) n FROM apt_unit_supply_conflicts`);
  const sample = await db.execute(`
    SELECT held_supply_cents, reason, substr(provenance_json,1,180) p
    FROM apt_unit_supply_conflicts LIMIT 8
  `);

  const priceExact = all.exactPair + all.exactFloor;
  const cohortSafeCov = priceExact + all.cohortSafe;
  const report = {
    seoul12: all,
    byCohort,
    priceLevelExactCoverage: all.total ? priceExact / all.total : 0,
    cohortMembershipSafeCoverage: all.total ? cohortSafeCov / all.total : 0,
    trendUsableCoverage: all.total ? cohortSafeCov / all.total : 0,
    resolverInserts: usedResolvers.size,
    cohortSafePairs: safePairs,
    cohortAmbiguousPairs: crossPairs,
    conflicts: num(conflicts.rows[0]?.n),
    conflictSample: sample.rows,
    dongFloorTx: 0,
    dongFloorNote: "transactions.dong is legal-dong, not building dong; R1 cannot fire",
    now,
  };
  writeFileSync("/tmp/building-hub-bulk/external-evidence/resolver-coverage.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
