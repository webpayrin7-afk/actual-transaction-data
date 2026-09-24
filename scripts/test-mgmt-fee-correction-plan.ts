/**
 * Fixture tests for the 54-row correction plan.
 * Does not call the fee API or open a database.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CorrectionAbort,
  applyCorrection,
  applyRollback,
  buildCorrectionPlan,
  sha256,
  type FeeRowSnapshot,
  type ReconciledRow,
} from "./mgmt-fee-canonical/correction-plan";

const UPDATED_AT = "2026-09-18T22:50:00.288Z";

function row(partial: Partial<FeeRowSnapshot> & Pick<FeeRowSnapshot, "complex_id" | "period_yyyymm" | "total_fee" | "source" | "amount_basis">): FeeRowSnapshot {
  return {
    common_fee: partial.total_fee,
    individual_fee: 0,
    long_term_repair_reserve: 0,
    per_area_common_fee: null,
    per_area_total_fee: null,
    area_basis_sqm: null,
    household_basis: null,
    source_version: "fixture",
    updated_at: "2026-09-01T00:00:00.000Z",
    per_area_individual_fee: null,
    per_area_reserve_fee: null,
    area_basis: null,
    fee_status: null,
    ...partial,
  };
}

function reconciled(partial: Partial<ReconciledRow> & Pick<ReconciledRow, "complex_id" | "period_yyyymm" | "classification">): ReconciledRow {
  return {
    stored_amount: 10,
    canonical_amount: 15,
    delta: 5,
    source: "MOLIT_KAPT_FEE_V3",
    amount_basis: "complex_month_total_krw",
    ...partial,
  };
}

function main(): void {
  const exact = row({
    complex_id: "cx_exact",
    period_yyyymm: "202601",
    total_fee: 100,
    source: "MOLIT_PORTAL_OPENAPI",
    amount_basis: "portal_operation_sum_krw",
  });
  const under = row({
    complex_id: "cx_under",
    period_yyyymm: "202601",
    total_fee: 10,
    common_fee: 10,
    source: "MOLIT_KAPT_FEE_V3",
    amount_basis: "complex_month_total_krw",
  });
  const missing = row({
    complex_id: "cx_4c63d9a100973c60",
    period_yyyymm: "202608",
    total_fee: 0,
    common_fee: 0,
    individual_fee: 0,
    long_term_repair_reserve: 0,
    source: "MOLIT_PORTAL_OPENAPI",
    amount_basis: "portal_operation_sum_krw",
    fee_status: "INCOMPLETE",
  });
  const reconciledRows: ReconciledRow[] = [
    reconciled({
      complex_id: exact.complex_id,
      period_yyyymm: exact.period_yyyymm,
      classification: "EXACT_MATCH",
      stored_amount: 100,
      canonical_amount: 100,
      delta: 0,
      source: exact.source,
      amount_basis: exact.amount_basis,
    }),
    reconciled({
      complex_id: missing.complex_id,
      period_yyyymm: missing.period_yyyymm,
      classification: "STORED_ZERO_BUT_MISSING",
      stored_amount: 0,
      canonical_amount: null,
      delta: null,
      source: missing.source,
      amount_basis: missing.amount_basis,
    }),
    reconciled({
      complex_id: under.complex_id,
      period_yyyymm: under.period_yyyymm,
      classification: "UNDERCOUNT",
      stored_amount: 10,
      canonical_amount: 15,
      delta: 5,
      source: under.source,
      amount_basis: under.amount_basis,
    }),
  ];
  const built = buildCorrectionPlan({
    reconciled: reconciledRows,
    snapshots: [missing, exact, under],
    updatedAt: UPDATED_AT,
  });
  assert.equal(built.correction.summary.UPDATE, 1);
  assert.equal(built.correction.summary.DELETE, 1);
  assert.equal(built.correction.guards.exact_match_untouched, 1);
  assert.equal(built.correction.entries.some((entry) => entry.complex_id === exact.complex_id), false);
  assert.deepEqual(
    built.correction.entries.map((entry) => entry.action),
    ["DELETE", "UPDATE"],
  );
  assert.equal(built.correction.entries[1].proposed_source, under.source);
  assert.equal(built.correction.entries[1].proposed_amount_basis, under.amount_basis);
  assert.equal(built.correction.entries[1].after?.total_fee, 15);
  assert.equal(built.correction.entries[0].after, null);

  const reordered = buildCorrectionPlan({
    reconciled: [...reconciledRows].reverse(),
    snapshots: [under, missing],
    updatedAt: UPDATED_AT,
  });
  assert.equal(reordered.correction.hash, built.correction.hash);

  const original = [exact, under, missing];
  const corrected = applyCorrection(original, built.correction);
  assert.equal(corrected.some((item) => item.complex_id === exact.complex_id && item.total_fee === 100), true);
  assert.equal(corrected.some((item) => item.period_yyyymm === "202608"), false);
  assert.equal(corrected.find((item) => item.complex_id === "cx_under")?.total_fee, 15);
  assert.equal(corrected.find((item) => item.complex_id === "cx_under")?.source, under.source);

  const restored = applyRollback(corrected, built.rollback);
  const ordered = [exact, missing, under].sort(
    (a, b) => a.complex_id.localeCompare(b.complex_id) || a.period_yyyymm.localeCompare(b.period_yyyymm),
  );
  assert.deepEqual(restored, ordered);

  const drifted = original.map((item) => (item.complex_id === "cx_under" ? { ...item, total_fee: 11 } : item));
  assert.throws(() => applyCorrection(drifted, built.correction), CorrectionAbort);
  assert.equal(drifted.find((item) => item.complex_id === "cx_under")?.total_fee, 11);

  assert.throws(() => applyCorrection(original, built.correction, [1, 0]), /affected row count mismatch/);
  assert.equal(original.find((item) => item.complex_id === "cx_under")?.total_fee, 10);
  assert.equal(original.some((item) => item.period_yyyymm === "202608"), true);

  assert.throws(
    () =>
      buildCorrectionPlan({
        reconciled: [
          reconciled({
            complex_id: "cx_new",
            period_yyyymm: "202601",
            classification: "ERROR",
          }),
        ],
        snapshots: [],
        updatedAt: UPDATED_AT,
      }),
    /not a correction candidate/,
  );

  const root = resolve(import.meta.dirname, "..");
  const dir = resolve(root, "data/poc/mgmt-fee-canonical");
  const report = JSON.parse(readFileSync(resolve(dir, "reconciliation-report.json"), "utf8")) as {
    generated_at: string;
    rows_detail: ReconciledRow[];
  };
  const snapshot = JSON.parse(readFileSync(resolve(dir, "correction-before-snapshot.json"), "utf8")) as {
    rows: FeeRowSnapshot[];
  };
  const production = buildCorrectionPlan({
    reconciled: report.rows_detail,
    snapshots: snapshot.rows,
    updatedAt: report.generated_at,
    expect: { exact: 72, update: 52, delete: 2 },
  });
  const committedCorrection = JSON.parse(readFileSync(resolve(dir, "correction-manifest.json"), "utf8"));
  const committedRollback = JSON.parse(readFileSync(resolve(dir, "rollback-manifest.json"), "utf8"));
  assert.equal(production.correction.hash, committedCorrection.hash);
  assert.equal(production.rollback.hash, committedRollback.hash);
  assert.equal(committedCorrection.hash, sha256(committedCorrection.entries));
  assert.equal(production.correction.summary.total, 54);
  assert.equal(production.correction.guards.exact_match_untouched, 72);
  const exactIds = new Set(
    report.rows_detail.filter((item) => item.classification === "EXACT_MATCH").map((item) => `${item.complex_id}|${item.period_yyyymm}`),
  );
  assert.equal(exactIds.size, 72);
  assert.equal(
    production.correction.entries.some((entry) => exactIds.has(`${entry.complex_id}|${entry.period_yyyymm}`)),
    false,
  );
  const live = snapshot.rows;
  const applied = applyCorrection(live, production.correction);
  const roundTrip = applyRollback(applied, production.rollback);
  assert.equal(roundTrip.length, live.length);
  assert.deepEqual(roundTrip, [...live].sort((a, b) => a.complex_id.localeCompare(b.complex_id) || a.period_yyyymm.localeCompare(b.period_yyyymm)));

  console.log(
    JSON.stringify({
      ok: true,
      hash: production.correction.hash,
      rollback_hash: production.rollback.hash,
    }),
  );
}

main();
