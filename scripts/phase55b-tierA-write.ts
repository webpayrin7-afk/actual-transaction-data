/**
 * Phase 5.5b — Tier A production INSERT (groups + baselines only).
 * Atomic batch. No UPDATE/DELETE. No flag changes.
 *
 *   npx tsx scripts/phase55b-tierA-write.ts --execute
 *   npx tsx scripts/phase55b-tierA-write.ts           # dry-run
 */
import { createClient } from "@libsql/client";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const KEYS = [
  "daechi-palace",
  "mapo-raemian-prugio",
  "acro-riverpark",
  "hannam-thehill",
] as const;

const execute = process.argv.includes("--execute");

type G = {
  groupKey: string;
  exclusiveAreaMin: number;
  exclusiveAreaMax: number;
  groupConfidenceHigh: boolean;
  label: string | null;
  source: string;
};
type B = {
  groupKey: string;
  complexKey: string;
  baselineUntil: string;
  priorMaxAmount: number;
  priorMaxDealDate: string | null;
  confidence: string;
  completeness: string;
  preWarehouseTradeCount: number;
  label: string | null;
};

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("missing turso");
  const db = createClient({ url, authToken });
  const plan = JSON.parse(readFileSync("/tmp/tierA-write-plan.json", "utf8"));

  // conflict re-check
  for (const ck of KEYS) {
    const g = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM apt_pyeong_groups WHERE complex_key = ?`,
      args: [ck],
    });
    const b = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM apt_pyeong_group_baselines WHERE complex_key = ?`,
      args: [ck],
    });
    const gn = Number((g.rows[0] as any).n);
    const bn = Number((b.rows[0] as any).n);
    if (gn || bn) {
      throw new Error(`CONFLICT stop: ${ck} already has groups=${gn} baselines=${bn}`);
    }
  }

  // classification presence (informational; not written here)
  const classInfo: Record<string, unknown> = {};
  for (const ck of KEYS) {
    const c = await db.execute({
      sql: `SELECT complex_key, apt_name_norm, classification, singoga_mode
            FROM apt_complex_classifications WHERE complex_key = ?`,
      args: [ck],
    });
    classInfo[ck] = c.rows[0] ?? null;
  }

  const groupRows: Array<{ ck: string; g: G; sortOrder: number }> = [];
  const baseRows: B[] = [];
  for (const ck of KEYS) {
    const groups = plan.complexes[ck].groups as G[];
    groups.forEach((g, i) => groupRows.push({ ck, g, sortOrder: i + 1 }));
    for (const b of plan.complexes[ck].baselines as B[]) {
      if (!(b.priorMaxAmount > 0)) throw new Error(`baseline without prior: ${b.groupKey}`);
      baseRows.push(b);
    }
  }

  const expected = {
    groupInserts: groupRows.length,
    baselineInserts: baseRows.length,
    total: groupRows.length + baseRows.length,
  };
  if (expected.groupInserts !== 34 || expected.baselineInserts !== 20) {
    throw new Error(`unexpected plan size ${JSON.stringify(expected)}`);
  }

  // mapping check
  const gkeys = new Set(groupRows.map((x) => x.g.groupKey));
  for (const b of baseRows) {
    if (!gkeys.has(b.groupKey)) throw new Error(`baseline orphan ${b.groupKey}`);
  }

  console.log(JSON.stringify({ execute, expected, classInfo }, null, 2));
  if (!execute) {
    console.log("dry-run only; pass --execute to write");
    return;
  }

  const computedAt = new Date().toISOString();
  const stmts: Array<{ sql: string; args: any[] }> = [];
  for (const { ck, g, sortOrder } of groupRows) {
    stmts.push({
      sql: `INSERT INTO apt_pyeong_groups (
        group_key, complex_key, market_label, display_mode,
        supply_area_min, supply_area_max, exclusive_area_min, exclusive_area_max,
        household_count, confidence, group_confidence_high, label_null_reason,
        sort_order, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        g.groupKey,
        ck,
        g.label == null || g.label === "" ? null : Number(g.label),
        g.label ? "label+range" : "range_only",
        null,
        null,
        g.exclusiveAreaMin,
        g.exclusiveAreaMax,
        null,
        g.groupConfidenceHigh ? "high" : "low",
        g.groupConfidenceHigh ? 1 : 0,
        g.label ? null : "phase55a-dryrun",
        sortOrder,
        g.source || "phase55b-tierA",
      ],
    });
  }
  for (const b of baseRows) {
    stmts.push({
      sql: `INSERT INTO apt_pyeong_group_baselines (
        group_key, complex_key, baseline_until, prior_max_amount, prior_max_deal_date,
        source, computed_at, confidence, completeness, pre_warehouse_trade_count, label
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        b.groupKey,
        b.complexKey,
        b.baselineUntil,
        b.priorMaxAmount,
        b.priorMaxDealDate,
        "phase55b-tierA",
        computedAt,
        b.confidence || "high",
        b.completeness || "pre-warehouse-molit-max",
        b.preWarehouseTradeCount ?? null,
        b.label,
      ],
    });
  }

  // all-or-nothing batch
  await db.batch(stmts, "write");

  // read-back counts
  const afterG = await db.execute(
    `SELECT complex_key, COUNT(*) n FROM apt_pyeong_groups
     WHERE complex_key IN (${KEYS.map(() => "?").join(",")}) GROUP BY 1`,
    [...KEYS],
  );
  const afterB = await db.execute(
    `SELECT complex_key, COUNT(*) n FROM apt_pyeong_group_baselines
     WHERE complex_key IN (${KEYS.map(() => "?").join(",")}) GROUP BY 1`,
    [...KEYS],
  );
  const gTotal = await db.execute({
    sql: `SELECT COUNT(*) n FROM apt_pyeong_groups WHERE complex_key IN (${KEYS.map(() => "?").join(",")})`,
    args: [...KEYS],
  });
  const bTotal = await db.execute({
    sql: `SELECT COUNT(*) n FROM apt_pyeong_group_baselines WHERE complex_key IN (${KEYS.map(() => "?").join(",")})`,
    args: [...KEYS],
  });

  // detailed match sample
  const mismatches: unknown[] = [];
  for (const b of baseRows) {
    const row = await db.execute({
      sql: `SELECT group_key, prior_max_amount, prior_max_deal_date, baseline_until, confidence, completeness
            FROM apt_pyeong_group_baselines WHERE group_key = ?`,
      args: [b.groupKey],
    });
    const r = row.rows[0] as any;
    if (!r) {
      mismatches.push({ type: "missing-baseline", groupKey: b.groupKey });
      continue;
    }
    if (Number(r.prior_max_amount) !== b.priorMaxAmount) {
      mismatches.push({ type: "prior_max_amount", groupKey: b.groupKey, got: r.prior_max_amount, exp: b.priorMaxAmount });
    }
    if (String(r.prior_max_deal_date ?? "") !== String(b.priorMaxDealDate ?? "")) {
      mismatches.push({ type: "prior_max_deal_date", groupKey: b.groupKey, got: r.prior_max_deal_date, exp: b.priorMaxDealDate });
    }
    if (String(r.baseline_until) !== b.baselineUntil) {
      mismatches.push({ type: "baseline_until", groupKey: b.groupKey, got: r.baseline_until, exp: b.baselineUntil });
    }
  }
  for (const { g } of groupRows) {
    const row = await db.execute({
      sql: `SELECT group_key FROM apt_pyeong_groups WHERE group_key = ?`,
      args: [g.groupKey],
    });
    if (!row.rows[0]) mismatches.push({ type: "missing-group", groupKey: g.groupKey });
    const br = await db.execute({
      sql: `SELECT group_key FROM apt_pyeong_group_baselines WHERE group_key = ?`,
      args: [g.groupKey],
    });
    // baselines only for prior>0 subset — mapping check: every baseline has group
  }
  for (const b of baseRows) {
    const gr = await db.execute({
      sql: `SELECT 1 FROM apt_pyeong_groups WHERE group_key = ?`,
      args: [b.groupKey],
    });
    if (!gr.rows[0]) mismatches.push({ type: "baseline-without-group", groupKey: b.groupKey });
  }

  const result = {
    writtenAt: computedAt,
    groupsWritten: Number((gTotal.rows[0] as any).n),
    baselinesWritten: Number((bTotal.rows[0] as any).n),
    updates: 0,
    deletes: 0,
    byComplexGroups: afterG.rows,
    byComplexBaselines: afterB.rows,
    expected,
    mismatches,
    classInfo,
    pass:
      Number((gTotal.rows[0] as any).n) === 34 &&
      Number((bTotal.rows[0] as any).n) === 20 &&
      mismatches.length === 0,
  };
  mkdirSync("data/poc/phase55b", { recursive: true });
  writeFileSync("data/poc/phase55b/write-result.json", JSON.stringify(result, null, 2));
  writeFileSync("data/poc/phase55b/write-plan.json", JSON.stringify(plan, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
