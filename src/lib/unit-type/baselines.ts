import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Client } from "@libsql/client";

export type AptPyeongGroupBaselineRow = {
  groupKey: string;
  complexKey: string;
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
  await params.db.execute(`DELETE FROM apt_pyeong_group_baselines`);
  for (const r of rows) {
    await params.db.execute({
      sql: `INSERT INTO apt_pyeong_group_baselines (
        group_key, complex_key, baseline_until, prior_max_amount, prior_max_deal_date,
        source, computed_at, confidence, completeness, pre_warehouse_trade_count, label
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  }
  return rows.length;
}

export async function loadBaselinePriorMaxByComplex(
  db: Client,
  complexKey: string,
): Promise<Map<string, number>> {
  const res = await db.execute({
    sql: `SELECT group_key, prior_max_amount FROM apt_pyeong_group_baselines
          WHERE complex_key = ?`,
    args: [complexKey],
  });
  const out = new Map<string, number>();
  for (const row of res.rows) {
    const r = row as Record<string, unknown>;
    const amount = Number(r.prior_max_amount ?? 0);
    if (amount > 0) out.set(String(r.group_key), amount);
  }
  return out;
}
