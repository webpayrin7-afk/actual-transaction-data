/**
 * Offline tests for the canonical management-fee dry-run.
 * Local fixtures only. No fee API. No Production database.
 *
 *   npx tsx scripts/test-mgmt-fee-canonical-dryrun.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { classifyFeeMonth } from "./mgmt-fee-canonical/classify";
import { CheckpointStore } from "./mgmt-fee-canonical/checkpoint";
import {
  parsePeriodList,
  prepareSampleCohort,
  rowPresence,
  validatePeriod,
  feeRowKey,
} from "./mgmt-fee-canonical/cohort";
import { runCanonicalDryRun, assertUpsertSqlAllowed } from "./mgmt-fee-canonical/dry-run";
import { compareOpCatalogs } from "./mgmt-fee-canonical/op-catalog";
import {
  CANONICAL_UPSERT_SQL,
  type OpObservation,
  type SampleMember,
} from "./mgmt-fee-canonical/types";

const OPS = ["op_a", "op_b", "op_c"] as const;
const NOW = "2026-09-18T00:00:00.000Z";

const cohort: SampleMember[] = [
  { complex_id: "cx_dryrun_seoul_1", region: "seoul" },
  { complex_id: "cx_dryrun_gg_1", region: "gyeonggi" },
];

function obs(
  op: string,
  state: OpObservation["state"],
  amount: number | null = null,
  error?: string,
): OpObservation {
  return { op, state, amount, error };
}

function run(overrides: Partial<Parameters<typeof runCanonicalDryRun>[0]> = {}) {
  return runCanonicalDryRun({
    cohort,
    periods: ["202507"],
    expectedOps: OPS,
    now: NOW,
    ...overrides,
  });
}

function main(): void {
  assertUpsertSqlAllowed(CANONICAL_UPSERT_SQL);
  assert.doesNotMatch(CANONICAL_UPSERT_SQL, /\bDELETE\b/i);
  assert.doesNotMatch(CANONICAL_UPSERT_SQL, /\bALTER\s+TABLE\b/i);
  assert.match(
    CANONICAL_UPSERT_SQL,
    /ON CONFLICT\(complex_id, period_yyyymm\)/,
  );

  const diff = compareOpCatalogs();
  assert.ok(diff.shared.includes("getHsmpCleaningCostInfoV3"));
  assert.ok(diff.shared.includes("getHsmpMonthFeeInfoV3"));
  assert.ok(diff.main_only.includes("getHsmpDisinfectCostInfoV3"));
  assert.ok(diff.reference_only.includes("getHsmpDisinfectionCostInfoV3"));
  assert.ok(diff.reference_only.includes("getHsmpHeatCostInfoV3"));
  assert.equal(new Set(diff.main_ops).size, diff.main_ops.length);
  assert.equal(new Set(diff.reference_ops).size, diff.reference_ops.length);
  assert.ok(diff.main_only.length > 0);
  assert.ok(diff.reference_only.length > 0);

  const missingNotZero = classifyFeeMonth({
    complex_id: "cx_dryrun_seoul_1",
    period_yyyymm: "202507",
    expectedOps: OPS,
    observations: [
      obs("op_a", "success", 1000),
      obs("op_b", "missing", 0),
      obs("op_c", "success", 250),
    ],
  });
  assert.equal(missingNotZero.checkpoint_status, "PARTIAL");
  assert.equal(missingNotZero.result?.completeness, "PARTIAL");
  assert.equal(missingNotZero.amount, 1250);
  assert.deepEqual(missingNotZero.missing_ops, ["op_b"]);
  assert.ok(!missingNotZero.successful_ops.includes("op_b"));

  const partial = classifyFeeMonth({
    complex_id: "cx_dryrun_seoul_1",
    period_yyyymm: "202507",
    expectedOps: OPS,
    observations: [
      obs("op_a", "success", 10),
      obs("op_b", "failed", null, "http 429"),
      obs("op_c", "success", 5),
    ],
  });
  assert.equal(partial.result?.completeness, "PARTIAL");
  assert.equal(partial.amount, 15);
  assert.deepEqual(partial.failed_ops, ["op_b"]);

  const allNull = classifyFeeMonth({
    complex_id: "cx_dryrun_seoul_1",
    period_yyyymm: "202507",
    expectedOps: OPS,
    observations: OPS.map((op) => obs(op, "missing", null)),
  });
  assert.equal(allNull.result?.completeness, "MISSING");
  assert.equal(allNull.amount, null);
  assert.notEqual(allNull.amount, 0);

  const explicitZero = classifyFeeMonth({
    complex_id: "cx_dryrun_seoul_1",
    period_yyyymm: "202507",
    expectedOps: OPS,
    observations: OPS.map((op) => obs(op, "success", 0)),
  });
  assert.equal(explicitZero.result?.completeness, "COMPLETE");
  assert.equal(explicitZero.amount, 0);

  const unexpected = classifyFeeMonth({
    complex_id: "cx_dryrun_seoul_1",
    period_yyyymm: "202507",
    expectedOps: ["op_a"],
    observations: [
      obs("op_a", "success", 3),
      obs("op_extra", "success", 9999),
    ],
  });
  assert.equal(unexpected.amount, 3);
  assert.match(unexpected.last_error ?? "", /unexpected op/);

  const first = run({
    targets: [
      {
        complex_id: "cx_dryrun_seoul_1",
        period_yyyymm: "202507",
        observations: OPS.map((op) => obs(op, "success", 100)),
      },
    ],
  });
  assert.equal(first.report.would_insert, 1);
  assert.equal(first.report.would_update, 0);
  assert.equal(first.report.COMPLETE, 1);
  assert.equal(first.report.MISSING, 1);
  assert.equal(first.report.total_targets, 2);
  assert.equal(
    first.plans.filter((plan) => plan.action === "insert").length,
    1,
  );
  assert.equal(first.checkpoint.shouldSkip("cx_dryrun_seoul_1", "202507"), true);
  assert.equal(first.checkpoint.isResumable("cx_dryrun_gg_1", "202507"), true);

  const second = run({
    checkpoint: first.checkpoint,
    existingFeeKeys: [
      { complex_id: "cx_dryrun_seoul_1", period_yyyymm: "202507" },
    ],
    targets: [
      {
        complex_id: "cx_dryrun_seoul_1",
        period_yyyymm: "202507",
        observations: OPS.map((op) => obs(op, "success", 999)),
      },
    ],
  });
  assert.equal(second.report.would_insert, 0);
  assert.equal(second.report.checkpoint_skipped, 1);
  const skipped = second.plans.find(
    (plan) => plan.complex_id === "cx_dryrun_seoul_1",
  );
  assert.equal(skipped?.action, "skip");
  assert.equal(skipped?.reason, "checkpoint COMPLETE");
  const insertKeys = second.plans
    .filter((plan) => plan.action === "insert")
    .map((plan) => feeRowKey(plan.complex_id, plan.period_yyyymm));
  assert.equal(new Set(insertKeys).size, insertKeys.length);

  const existingUpdate = run({
    existingFeeKeys: [
      { complex_id: "cx_dryrun_seoul_1", period_yyyymm: "202507" },
    ],
    targets: [
      {
        complex_id: "cx_dryrun_seoul_1",
        period_yyyymm: "202507",
        observations: OPS.map((op) => obs(op, "success", 40)),
      },
    ],
  });
  assert.equal(existingUpdate.report.would_update, 1);
  assert.equal(existingUpdate.report.would_insert, 0);
  assert.equal(
    rowPresence(
      "cx_dryrun_seoul_1",
      "202507",
      new Set([feeRowKey("cx_dryrun_seoul_1", "202507")]),
    ),
    "EXISTING",
  );
  assert.equal(
    rowPresence("cx_dryrun_gg_1", "202507", new Set()),
    "NEW",
  );

  const failed = run({
    targets: [
      {
        complex_id: "cx_dryrun_seoul_1",
        period_yyyymm: "202507",
        observations: OPS.map((op) => obs(op, "failed", 0, "timeout")),
      },
    ],
  });
  assert.equal(failed.report.FAILED, 1);
  assert.equal(failed.report.would_skip >= 1, true);
  assert.equal(failed.checkpoint.statusOf("cx_dryrun_seoul_1", "202507"), "FAILED");
  assert.equal(failed.checkpoint.isResumable("cx_dryrun_seoul_1", "202507"), true);
  assert.equal(
    failed.plans.find((plan) => plan.complex_id === "cx_dryrun_seoul_1")?.total_fee,
    null,
  );

  const resumed = run({
    checkpoint: failed.checkpoint,
    targets: [
      {
        complex_id: "cx_dryrun_seoul_1",
        period_yyyymm: "202507",
        observations: OPS.map((op) => obs(op, "success", 7)),
      },
    ],
  });
  assert.equal(resumed.report.checkpoint_skipped, 0);
  assert.equal(resumed.report.would_insert, 1);
  assert.equal(resumed.checkpoint.statusOf("cx_dryrun_seoul_1", "202507"), "COMPLETE");

  const roundTrip = CheckpointStore.parse(resumed.checkpoint.serialize());
  assert.equal(roundTrip.shouldSkip("cx_dryrun_seoul_1", "202507"), true);

  assert.equal(validatePeriod("202507"), "202507");
  assert.equal(validatePeriod("202609"), "202609");
  assert.throws(() => validatePeriod("202513"), /month out of range/);
  assert.throws(() => validatePeriod("2025-07"), /YYYYMM/);
  assert.throws(() => validatePeriod(""), /YYYYMM/);
  assert.deepEqual(parsePeriodList("202507, 202509"), ["202507", "202509"]);
  assert.equal(parsePeriodList("202507, 202509").length, 2);
  assert.throws(() => parsePeriodList(""), /explicit period/);
  assert.throws(() => run({ periods: [] }), /explicit periods/);

  assert.equal(prepareSampleCohort(cohort, 5).length, 2);
  assert.throws(
    () =>
      prepareSampleCohort(
        Array.from({ length: 6 }, (_, i) => ({
          complex_id: `cx_dryrun_extra_${i}`,
          region: i % 2 === 0 ? "seoul" : "gyeonggi",
        })),
        5,
      ),
    /cohort cap 5 exceeded/,
  );
  assert.throws(
    () => prepareSampleCohort([{ complex_id: "apt_name_only" }]),
    /explicit complex_id/,
  );
  assert.throws(
    () => prepareSampleCohort([{ complex_id: "11140:남산타운" }]),
    /explicit complex_id/,
  );
  assert.throws(
    () =>
      prepareSampleCohort([
        { complex_id: "cx_dryrun_seoul_1" },
        { complex_id: "cx_dryrun_seoul_1" },
      ]),
    /duplicate complex_id/,
  );
  assert.throws(
    () =>
      run({
        targets: [
          {
            complex_id: "cx_dryrun_seoul_1",
            period_yyyymm: "202507",
            observations: [],
          },
          {
            complex_id: "cx_dryrun_seoul_1",
            period_yyyymm: "202507",
            observations: [],
          },
        ],
      }),
    /duplicate target/,
  );

  const source = readFileSync(
    resolve("scripts/mgmt-fee-canonical/dry-run.ts"),
    "utf8",
  );
  assert.equal(source.includes("apis.data.go.kr"), false);
  assert.equal(source.includes("createClient"), false);
  assert.equal(source.includes("ALTER TABLE"), false);

  const dir = mkdtempSync(join(tmpdir(), "mgmt-fee-dryrun-"));
  try {
    const checkpointPath = join(dir, "checkpoint.json");
    const outPath = join(dir, "report.json");
    const tsxCli = [
      resolve("node_modules/tsx/dist/cli.mjs"),
      resolve("/workspace/node_modules/tsx/dist/cli.mjs"),
    ].find((path) => existsSync(path));
    assert.ok(tsxCli, "tsx cli missing");
    const ran = spawnSync(
      process.execPath,
      [
        tsxCli,
        resolve("scripts/mgmt-fee-canonical/run-dry-run.mts"),
        "--fixture",
        resolve("data/poc/mgmt-fee-canonical/fixture.sample.json"),
        "--periods",
        "202507,202508",
        "--checkpoint",
        checkpointPath,
        "--out",
        outPath,
        "--now",
        NOW,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(ran.status, 0, ran.stderr || ran.stdout);
    const report = JSON.parse(readFileSync(outPath, "utf8")) as {
      report: {
        total_targets: number;
        COMPLETE: number;
        PARTIAL: number;
        MISSING: number;
        would_insert: number;
        would_update: number;
        would_skip: number;
        errors: unknown[];
      };
    };
    assert.equal(report.report.total_targets, 4);
    assert.equal(report.report.COMPLETE, 1);
    assert.equal(report.report.PARTIAL, 1);
    assert.equal(report.report.MISSING, 2);
    assert.equal(report.report.would_update, 1);
    assert.equal(report.report.would_insert, 0);
    assert.equal(report.report.would_skip, 3);
    const saved = CheckpointStore.parse(readFileSync(checkpointPath, "utf8"));
    assert.equal(saved.shouldSkip("cx_dryrun_seoul_1", "202507"), true);

    const refused = spawnSync(
      process.execPath,
      [
        tsxCli,
        resolve("scripts/mgmt-fee-canonical/run-dry-run.mts"),
        "--apply",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(refused.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        cases: [
          "missing-not-zero",
          "partial-sum",
          "all-null-missing",
          "explicit-zero-complete",
          "rerun-no-duplicate-insert",
          "complete-checkpoint-skip",
          "failed-checkpoint-resume",
          "period-validation",
          "cohort-cap",
          "catalog-diff",
          "cli-fixture",
        ],
      },
      null,
      2,
    ),
  );
}

main();
