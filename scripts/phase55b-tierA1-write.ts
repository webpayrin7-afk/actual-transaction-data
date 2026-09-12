/**
 * Phase 5.5b Tier A-1 — INSERT classifications + groups + baselines
 * for daechi-palace, mapo-raemian-prugio, acro-riverpark only.
 * hannam-thehill excluded. INSERT only. Atomic batch.
 *
 *   npx tsx scripts/phase55b-tierA1-write.ts --execute
 */
import { createClient } from "@libsql/client";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const KEYS = [
  "daechi-palace",
  "mapo-raemian-prugio",
  "acro-riverpark",
] as const;

const CLASS_ROWS = [
  {
    complexKey: "daechi-palace",
    aptNameNorm: "래미안대치팰리스",
    lawdCd: "11680",
    gu: "강남구",
    classification: "auto-safe",
    singogaMode: "market_group",
    labelConfidence: 0.91,
    groupConfidenceHigh: 1,
    sourcePhase: "phase4",
    provenanceJson: JSON.stringify({
      role: "tierA1",
      phase4Class: "auto-safe",
      phase4Singoga: "market_group",
    }),
  },
  {
    complexKey: "mapo-raemian-prugio",
    aptNameNorm: "마포래미안푸르지오4단지",
    lawdCd: "11440",
    gu: "마포구",
    classification: "group-safe-label-unknown",
    singogaMode: "market_group",
    labelConfidence: 0.53,
    groupConfidenceHigh: 1,
    sourcePhase: "phase4",
    provenanceJson: JSON.stringify({
      role: "tierA1",
      phase4Class: "group-safe-label-unknown",
      phase4Singoga: "market_group",
    }),
  },
  {
    complexKey: "acro-riverpark",
    aptNameNorm: "아크로리버파크",
    lawdCd: "11650",
    gu: "서초구",
    classification: "group-safe-label-unknown",
    singogaMode: "market_group",
    labelConfidence: 0.39,
    groupConfidenceHigh: 1,
    sourcePhase: "phase4",
    provenanceJson: JSON.stringify({
      role: "tierA1",
      phase4Class: "group-safe-label-unknown",
      phase4Singoga: "market_group",
    }),
  },
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

  for (const ck of KEYS) {
    const c = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM apt_complex_classifications WHERE complex_key = ?`,
      args: [ck],
    });
    const g = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM apt_pyeong_groups WHERE complex_key = ?`,
      args: [ck],
    });
    const b = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM apt_pyeong_group_baselines WHERE complex_key = ?`,
      args: [ck],
    });
    const cn = Number((c.rows[0] as { n: number }).n);
    const gn = Number((g.rows[0] as { n: number }).n);
    const bn = Number((b.rows[0] as { n: number }).n);
    if (cn || gn || bn) {
      throw new Error(
        `CONFLICT stop: ${ck} already has class=${cn} groups=${gn} baselines=${bn}`,
      );
    }
  }

  // ensure hannam untouched / not in write set
  const hannam = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM apt_complex_classifications WHERE complex_key = 'hannam-thehill'`,
  });
  if (Number((hannam.rows[0] as { n: number }).n) > 0) {
    // ok if somehow present — we just must not write it
  }

  const groupRows: Array<{ ck: string; g: G; sortOrder: number }> = [];
  const baseRows: B[] = [];
  for (const ck of KEYS) {
    const groups = plan.complexes[ck].groups as G[];
    groups.forEach((g, i) => groupRows.push({ ck, g, sortOrder: i + 1 }));
    for (const b of plan.complexes[ck].baselines as B[]) {
      if (!(b.priorMaxAmount > 0)) {
        throw new Error(`baseline without prior: ${b.groupKey}`);
      }
      baseRows.push(b);
    }
  }

  const expected = {
    classificationInserts: CLASS_ROWS.length,
    groupInserts: groupRows.length,
    baselineInserts: baseRows.length,
    total: CLASS_ROWS.length + groupRows.length + baseRows.length,
  };
  if (
    expected.classificationInserts !== 3 ||
    expected.groupInserts !== 25 ||
    expected.baselineInserts !== 12 ||
    expected.total !== 40
  ) {
    throw new Error(`unexpected counts: ${JSON.stringify(expected)}`);
  }

  const gkeys = new Set(groupRows.map((x) => x.g.groupKey));
  for (const b of baseRows) {
    if (!gkeys.has(b.groupKey)) {
      throw new Error(`baseline orphan ${b.groupKey}`);
    }
  }

  console.log(JSON.stringify({ execute, expected }, null, 2));
  if (!execute) {
    console.log("dry-run only; pass --execute to write");
    return;
  }

  const computedAt = new Date().toISOString();
  const stmts: Array<{ sql: string; args: unknown[] }> = [];

  for (const c of CLASS_ROWS) {
    stmts.push({
      sql: `INSERT INTO apt_complex_classifications (
        complex_key, apt_name_norm, lawd_cd, gu, classification, singoga_mode,
        label_confidence, group_confidence_high, source_phase, provenance_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        c.complexKey,
        c.aptNameNorm,
        c.lawdCd,
        c.gu,
        c.classification,
        c.singogaMode,
        c.labelConfidence,
        c.groupConfidenceHigh,
        c.sourcePhase,
        c.provenanceJson,
        computedAt,
      ],
    });
  }

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
        g.source || "phase55b-tierA1",
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
        "phase55b-tierA1",
        computedAt,
        b.confidence || "high",
        b.completeness || "pre-warehouse-molit-max",
        b.preWarehouseTradeCount ?? null,
        b.label,
      ],
    });
  }

  await db.batch(stmts, "write");

  // read-back
  const mismatches: unknown[] = [];
  for (const c of CLASS_ROWS) {
    const row = await db.execute({
      sql: `SELECT classification, singoga_mode, apt_name_norm FROM apt_complex_classifications WHERE complex_key = ?`,
      args: [c.complexKey],
    });
    const r = row.rows[0] as Record<string, unknown> | undefined;
    if (!r) mismatches.push({ type: "missing-class", ck: c.complexKey });
    else if (String(r.classification) !== c.classification) {
      mismatches.push({
        type: "class-mismatch",
        ck: c.complexKey,
        got: r.classification,
      });
    } else if (String(r.singoga_mode) !== c.singogaMode) {
      mismatches.push({
        type: "mode-mismatch",
        ck: c.complexKey,
        got: r.singoga_mode,
      });
    }
  }

  for (const { g } of groupRows) {
    const row = await db.execute({
      sql: `SELECT 1 FROM apt_pyeong_groups WHERE group_key = ?`,
      args: [g.groupKey],
    });
    if (!row.rows[0]) mismatches.push({ type: "missing-group", groupKey: g.groupKey });
  }

  for (const b of baseRows) {
    const row = await db.execute({
      sql: `SELECT prior_max_amount, prior_max_deal_date, baseline_until, confidence, completeness
            FROM apt_pyeong_group_baselines WHERE group_key = ?`,
      args: [b.groupKey],
    });
    const r = row.rows[0] as Record<string, unknown> | undefined;
    if (!r) {
      mismatches.push({ type: "missing-baseline", groupKey: b.groupKey });
      continue;
    }
    if (Number(r.prior_max_amount) !== b.priorMaxAmount) {
      mismatches.push({ type: "prior_max_amount", groupKey: b.groupKey });
    }
    if (String(r.prior_max_deal_date ?? "") !== String(b.priorMaxDealDate ?? "")) {
      mismatches.push({ type: "prior_max_deal_date", groupKey: b.groupKey });
    }
    if (String(r.baseline_until) !== b.baselineUntil) {
      mismatches.push({ type: "baseline_until", groupKey: b.groupKey });
    }
    if (String(r.confidence) !== (b.confidence || "high")) {
      mismatches.push({ type: "confidence", groupKey: b.groupKey });
    }
    if (String(r.completeness) !== (b.completeness || "pre-warehouse-molit-max")) {
      mismatches.push({ type: "completeness", groupKey: b.groupKey });
    }
    const gr = await db.execute({
      sql: `SELECT 1 FROM apt_pyeong_groups WHERE group_key = ?`,
      args: [b.groupKey],
    });
    if (!gr.rows[0]) {
      mismatches.push({ type: "baseline-without-group", groupKey: b.groupKey });
    }
  }

  const classN = await db.execute({
    sql: `SELECT COUNT(*) n FROM apt_complex_classifications WHERE complex_key IN (?,?,?)`,
    args: [...KEYS],
  });
  const groupN = await db.execute({
    sql: `SELECT COUNT(*) n FROM apt_pyeong_groups WHERE complex_key IN (?,?,?)`,
    args: [...KEYS],
  });
  const baseN = await db.execute({
    sql: `SELECT COUNT(*) n FROM apt_pyeong_group_baselines WHERE complex_key IN (?,?,?)`,
    args: [...KEYS],
  });
  const hannamAfter = await db.execute({
    sql: `SELECT
      (SELECT COUNT(*) FROM apt_complex_classifications WHERE complex_key='hannam-thehill') AS c,
      (SELECT COUNT(*) FROM apt_pyeong_groups WHERE complex_key='hannam-thehill') AS g,
      (SELECT COUNT(*) FROM apt_pyeong_group_baselines WHERE complex_key='hannam-thehill') AS b`,
  });

  const report = {
    phase: "5.5b-tierA1",
    expected,
    written: {
      classifications: Number((classN.rows[0] as { n: number }).n),
      groups: Number((groupN.rows[0] as { n: number }).n),
      baselines: Number((baseN.rows[0] as { n: number }).n),
      updates: 0,
      deletes: 0,
    },
    mismatches,
    mappingOk: mismatches.every(
      (m) => (m as { type: string }).type !== "baseline-without-group",
    ),
    hannamUntouched: hannamAfter.rows[0],
    pass:
      mismatches.length === 0 &&
      Number((classN.rows[0] as { n: number }).n) === 3 &&
      Number((groupN.rows[0] as { n: number }).n) === 25 &&
      Number((baseN.rows[0] as { n: number }).n) === 12,
  };

  mkdirSync("data/poc/phase55b", { recursive: true });
  writeFileSync(
    "data/poc/phase55b/tierA1-write-report.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
