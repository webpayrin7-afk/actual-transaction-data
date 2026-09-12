/**
 * Phase 5.3b — production write of apt_pyeong_group_baselines (19 rows ONLY).
 *
 *   npx tsx scripts/phase53b-write-baselines-production.ts
 *   npx tsx scripts/phase53b-write-baselines-production.ts --execute
 */
import { createClient, type Client } from "@libsql/client";
import {
  loadPhase53bBaselineFixture,
  type AptPyeongGroupBaselineRow,
} from "../src/lib/unit-type/baselines";

const EXPECTED_ROWS = 19;
const TABLE = "apt_pyeong_group_baselines";
const PILOT_COMPLEXES = [
  "hangang-daewoo",
  "parkrio",
  "banpo-xi",
  "jamsil-els",
] as const;

const BASELINE_DDL = `
CREATE TABLE IF NOT EXISTS apt_pyeong_group_baselines (
  group_key TEXT PRIMARY KEY,
  complex_key TEXT NOT NULL,
  baseline_until TEXT NOT NULL,
  prior_max_amount INTEGER NOT NULL,
  prior_max_deal_date TEXT,
  source TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'high',
  completeness TEXT NOT NULL DEFAULT 'pre-warehouse-molit-max',
  pre_warehouse_trade_count INTEGER,
  label TEXT
);
CREATE INDEX IF NOT EXISTS idx_apt_pyeong_group_baselines_complex
  ON apt_pyeong_group_baselines (complex_key);
`;

function getProductionClient(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("TURSO env required");
  if (url.startsWith("file:") || url === ":memory:") {
    throw new Error("Refusing local DB for production write");
  }
  return createClient({ url, authToken });
}

async function tableExists(db: Client, name: string): Promise<boolean> {
  const res = await db.execute({
    sql: `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`,
    args: [name],
  });
  return res.rows.length > 0;
}

function assertFixture(rows: AptPyeongGroupBaselineRow[]): void {
  if (rows.length !== EXPECTED_ROWS) {
    throw new Error(`expected ${EXPECTED_ROWS}, got ${rows.length}`);
  }
  const complexes = new Set(rows.map((r) => r.complexKey));
  for (const c of PILOT_COMPLEXES) {
    if (!complexes.has(c)) throw new Error(`missing complex ${c}`);
  }
  if (new Set(rows.map((r) => r.groupKey)).size !== EXPECTED_ROWS) {
    throw new Error("duplicate group_key");
  }
}

async function upsertRows(
  db: Client,
  rows: AptPyeongGroupBaselineRow[],
): Promise<number> {
  let n = 0;
  for (const r of rows) {
    await db.execute({
      sql: `INSERT INTO ${TABLE} (
        group_key, complex_key, baseline_until, prior_max_amount, prior_max_deal_date,
        source, computed_at, confidence, completeness, pre_warehouse_trade_count, label
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_key) DO UPDATE SET
        complex_key=excluded.complex_key,
        baseline_until=excluded.baseline_until,
        prior_max_amount=excluded.prior_max_amount,
        prior_max_deal_date=excluded.prior_max_deal_date,
        source=excluded.source,
        computed_at=excluded.computed_at,
        confidence=excluded.confidence,
        completeness=excluded.completeness,
        pre_warehouse_trade_count=excluded.pre_warehouse_trade_count,
        label=excluded.label`,
      args: [
        r.groupKey,
        r.complexKey,
        r.baselineUntil,
        r.priorMaxAmount,
        r.priorMaxDealDate,
        r.source,
        r.computedAt,
        r.confidence,
        r.completeness,
        r.preWarehouseTradeCount,
        r.label,
      ],
    });
    n += 1;
  }
  return n;
}

async function readBack(db: Client, expected: AptPyeongGroupBaselineRow[]) {
  const res = await db.execute(
    `SELECT group_key, complex_key, baseline_until, prior_max_amount,
            prior_max_deal_date, confidence, completeness
     FROM ${TABLE} ORDER BY group_key`,
  );
  const byKey = new Map(
    res.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return [String(r.group_key), r];
    }),
  );
  let matched = 0;
  const mismatches: unknown[] = [];
  for (const exp of expected) {
    const got = byKey.get(exp.groupKey);
    if (!got) {
      mismatches.push({ groupKey: exp.groupKey, error: "missing" });
      continue;
    }
    const ok =
      String(got.complex_key) === exp.complexKey &&
      String(got.baseline_until) === exp.baselineUntil &&
      Number(got.prior_max_amount) === exp.priorMaxAmount &&
      (got.prior_max_deal_date == null
        ? exp.priorMaxDealDate == null
        : String(got.prior_max_deal_date) === exp.priorMaxDealDate) &&
      String(got.confidence) === exp.confidence &&
      String(got.completeness) === exp.completeness;
    if (ok) matched += 1;
    else mismatches.push({ groupKey: exp.groupKey, got, exp });
  }
  return { count: res.rows.length, matched, mismatches };
}

async function main() {
  const doExecute = process.argv.includes("--execute");
  console.log(
    doExecute
      ? "[phase53b-write] EXECUTE"
      : "[phase53b-write] dry-run (pass --execute to write)",
  );
  const rows = loadPhase53bBaselineFixture();
  assertFixture(rows);
  console.log(
    JSON.stringify(
      {
        expectedRows: EXPECTED_ROWS,
        fixtureRows: rows.length,
        complexes: [...new Set(rows.map((r) => r.complexKey))],
        featureFlags: {
          ENABLE_MARKET_GROUP_BASELINE_SINGOGA:
            process.env.ENABLE_MARKET_GROUP_BASELINE_SINGOGA ?? "(unset/0)",
          POST_WH_SINGOGA_GAPS_CLEARED:
            process.env.POST_WH_SINGOGA_GAPS_CLEARED ?? "(unset)",
        },
      },
      null,
      2,
    ),
  );

  const db = getProductionClient();
  if (await tableExists(db, "apt_pyeong_groups")) {
    const g = await db.execute({
      sql: `SELECT group_key FROM apt_pyeong_groups WHERE complex_key IN (?,?,?,?)`,
      args: [...PILOT_COMPLEXES],
    });
    const existing = new Set(g.rows.map((r) => String(r.group_key)));
    const missing = rows.map((r) => r.groupKey).filter((k) => !existing.has(k));
    console.log(
      JSON.stringify({
        apt_pyeong_groups: {
          pilotGroupRows: existing.size,
          baselineKeysPresent: rows.length - missing.length,
          missing,
        },
      }),
    );
  }

  const beforeExists = await tableExists(db, TABLE);
  let beforeCount = 0;
  if (beforeExists) {
    const c = await db.execute(`SELECT COUNT(*) AS n FROM ${TABLE}`);
    beforeCount = Number((c.rows[0] as unknown as { n: number }).n);
  }
  console.log(JSON.stringify({ tableExists: beforeExists, beforeCount }));

  if (!doExecute) {
    console.log(
      JSON.stringify({
        dryRun: true,
        wouldWrite: EXPECTED_ROWS,
        note: "no production mutation performed",
      }),
    );
    return;
  }

  await db.executeMultiple(BASELINE_DDL);
  const written = await upsertRows(db, rows);
  const rb = await readBack(db, rows);
  console.log(JSON.stringify({ written, readBack: rb, featureFlagsUntouched: true }, null, 2));
  if (written !== 19 || rb.count !== 19 || rb.matched !== 19) {
    throw new Error("write/read-back failed");
  }
  console.log("[phase53b-write] OK 19/19");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
