import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Client } from "@libsql/client";
import {
  dualKeyWhere,
  resolveComplexIdFromMolit,
} from "@/lib/unit-type/complex-id";

export type AptPyeongGroupBaselineRow = {
  groupKey: string;
  complexKey: string;
  complexId?: string | null;
  baselineUntil: string;
  priorMaxAmount: number;
  priorMaxDealDate: string | null;
  source: string;
  computedAt: string;
  confidence: string;
  completeness: string;
  preWarehouseTradeCount: number | null;
  label: string | null;
};

type BaselineFixtureFile = {
  phase: string;
  description: string;
  productionWrite: boolean;
  rowCount: number;
  rows: Array<{
    group_key: string;
    complex_key: string;
    baseline_until: string;
    prior_max_amount: number;
    prior_max_deal_date: string | null;
    source: string;
    computed_at: string;
    confidence: string;
    completeness: string;
    pre_warehouse_trade_count?: number | null;
    label?: string | null;
  }>;
};

export const PHASE53B_BASELINE_FIXTURE_PATH =
  "data/poc/phase53b/apt-pyeong-group-baselines.fixture.json";

export function loadPhase53bBaselineFixture(
  rootDir = process.cwd(),
): AptPyeongGroupBaselineRow[] {
  const raw = JSON.parse(
    readFileSync(resolve(rootDir, PHASE53B_BASELINE_FIXTURE_PATH), "utf8"),
  ) as BaselineFixtureFile;
  if (raw.productionWrite === true) {
    throw new Error("fixture must keep productionWrite=false");
  }
  if (raw.rowCount !== raw.rows.length) {
    throw new Error(
      `fixture rowCount mismatch: meta=${raw.rowCount} rows=${raw.rows.length}`,
    );
  }
  return raw.rows.map((r) => ({
    groupKey: r.group_key,
    complexKey: r.complex_key,
    complexId: null,
    baselineUntil: r.baseline_until,
    priorMaxAmount: r.prior_max_amount,
    priorMaxDealDate: r.prior_max_deal_date,
    source: r.source,
    computedAt: r.computed_at,
    confidence: r.confidence,
    completeness: r.completeness,
    preWarehouseTradeCount:
      r.pre_warehouse_trade_count == null
        ? null
        : Number(r.pre_warehouse_trade_count),
    label: r.label ?? null,
  }));
}

export function baselinePriorMaxMap(
  rows: AptPyeongGroupBaselineRow[],
  complexKey?: string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (complexKey && r.complexKey !== complexKey) continue;
    if (r.priorMaxAmount > 0) out.set(r.groupKey, r.priorMaxAmount);
  }
  return out;
}

function assertLocalDbOnly(dbUrl: string | undefined, action: string): void {
  const url = (dbUrl ?? "").trim();
  if (!url || url.startsWith("file:") || url === ":memory:") return;
  throw new Error(
    `${action} refused: production/remote DB write is forbidden in Phase 5.3b (${url.slice(0, 32)}…)`,
  );
}

/**
 * Seed fixture baselines into a local/file DB only.
 * Never call against Turso production.
 */
export async function seedBaselinesFromFixtureLocalOnly(params: {
  db: Client;
  dbUrl?: string;
  rootDir?: string;
}): Promise<number> {
  assertLocalDbOnly(
    params.dbUrl ?? process.env.TURSO_DATABASE_URL,
    "baseline seed",
  );
  const rows = loadPhase53bBaselineFixture(params.rootDir);
  const info = await params.db.execute(
    `PRAGMA table_info(apt_pyeong_group_baselines)`,
  );
  const hasComplexId = info.rows.some((row) => String(row.name) === "complex_id");
  if (!hasComplexId) {
    await params.db.execute(
      `ALTER TABLE apt_pyeong_group_baselines ADD COLUMN complex_id TEXT`,
    );
  }
  await params.db.execute(`DELETE FROM apt_pyeong_group_baselines`);
  for (const r of rows) {
    await params.db.execute({
      sql: `INSERT INTO apt_pyeong_group_baselines (
        group_key, complex_key, complex_id, baseline_until, prior_max_amount, prior_max_deal_date,
        source, computed_at, confidence, completeness, pre_warehouse_trade_count, label
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        r.groupKey,
        r.complexKey,
        r.complexId ?? null,
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
  }
  return rows.length;
}

/**
 * Upsert a baseline row with dual-write (complex_id + complex_key).
 * Resolves complex_id from MOLIT source link when lawdCd/aptNameNorm provided;
 * does not invent canonical identities.
 */
export async function upsertBaselineDualKey(params: {
  db: Client;
  row: AptPyeongGroupBaselineRow;
  lawdCd?: string;
  aptNameNorm?: string;
}): Promise<void> {
  const { db, row } = params;
  let complexId = row.complexId ?? null;
  if (
    complexId == null &&
    params.lawdCd &&
    params.aptNameNorm
  ) {
    complexId = await resolveComplexIdFromMolit(
      db,
      params.lawdCd,
      params.aptNameNorm,
    );
  }
  if (complexId == null) {
    // Try via classification row for this complex_key
    const cls = await db.execute({
      sql: `SELECT complex_id, lawd_cd, apt_name_norm FROM apt_complex_classifications
            WHERE complex_key = ? LIMIT 1`,
      args: [row.complexKey],
    });
    if (cls.rows.length > 0) {
      const r = cls.rows[0] as Record<string, unknown>;
      if (r.complex_id) complexId = String(r.complex_id);
      else if (r.lawd_cd && r.apt_name_norm) {
        complexId = await resolveComplexIdFromMolit(
          db,
          String(r.lawd_cd),
          String(r.apt_name_norm),
        );
      }
    }
  }
  await db.execute({
    sql: `INSERT INTO apt_pyeong_group_baselines (
      group_key, complex_key, complex_id, baseline_until, prior_max_amount, prior_max_deal_date,
      source, computed_at, confidence, completeness, pre_warehouse_trade_count, label
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(group_key) DO UPDATE SET
      complex_key=excluded.complex_key,
      complex_id=COALESCE(excluded.complex_id, apt_pyeong_group_baselines.complex_id),
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
      row.groupKey,
      row.complexKey,
      complexId,
      row.baselineUntil,
      row.priorMaxAmount,
      row.priorMaxDealDate,
      row.source,
      row.computedAt,
      row.confidence,
      row.completeness,
      row.preWarehouseTradeCount,
      row.label,
    ],
  });
}

export async function loadBaselinePriorMaxByComplex(
  db: Client,
  complexKey: string,
  complexId?: string | null,
): Promise<Map<string, number>> {
  const pred = dualKeyWhere("b", complexId, complexKey);
  const res = await db.execute({
    sql: `SELECT b.group_key, b.prior_max_amount FROM apt_pyeong_group_baselines b
          WHERE ${pred.sql}`,
    args: pred.args,
  });
  const out = new Map<string, number>();
  for (const row of res.rows) {
    const r = row as Record<string, unknown>;
    const amount = Number(r.prior_max_amount ?? 0);
    if (amount > 0) out.set(String(r.group_key), amount);
  }
  return out;
}
