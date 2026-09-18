/**
 * Fixture tests for national KAPT inventory and the expansion-wave planner.
 * Does not call the fee API or open a database.
 */
import assert from "node:assert/strict";
import {
  aggregateInventory,
  buildProbePeriods,
  choosePublishedPeriod,
  classifyComplex,
  selectWaveSidos,
  sharedKaptCodes,
  type ComplexInput,
} from "./mgmt-fee-canonical/national-inventory";
import {
  chunkItems,
  parseExplicitPeriods,
  planWaveCohort,
  planWriteAction,
  runExpansionDryRun,
  type WaveComplex,
} from "./mgmt-fee-canonical/national-batch";
import { RateLimitStop, type ParsedOp } from "./mgmt-fee-canonical/live-parse";
import type { LiveCall } from "./mgmt-fee-canonical/live-calls";

function row(partial: Partial<ComplexInput> & Pick<ComplexInput, "complex_id" | "sido_code">): ComplexInput {
  return {
    sido: partial.sido ?? partial.sido_code,
    kapt_codes: [],
    has_fee: false,
    ...partial,
  };
}

function success(amount: number): ParsedOp {
  return {
    state: "success",
    http: 200,
    result_class: "ok_00",
    amount,
    numeric_fields: ["amount"],
    explicit_zero_fields: amount === 0 ? ["amount"] : [],
    echoed_kapt: "A00000001",
    error: null,
  };
}

const calls: LiveCall[] = [
  { op: "op_a", service: "common", service_name: "svc", in_main: false, in_reference: true },
  { op: "op_b", service: "individual", service_name: "svc", in_main: false, in_reference: true },
];

async function main(): Promise<void> {
  const rows = [
    row({ complex_id: "cx_loaded", sido_code: "11", sido: "서울특별시", kapt_codes: ["A10000001"], has_fee: true }),
    row({ complex_id: "cx_ready_busan", sido_code: "26", sido: "부산광역시", kapt_codes: ["A20000001"] }),
    row({ complex_id: "cx_none", sido_code: "26", sido: "부산광역시" }),
    row({ complex_id: "cx_bad", sido_code: "27", sido: "대구광역시", kapt_codes: ["not-a-code"] }),
    row({ complex_id: "cx_share_a", sido_code: "28", sido: "인천광역시", kapt_codes: ["A30000001"] }),
    row({ complex_id: "cx_share_b", sido_code: "28", sido: "인천광역시", kapt_codes: ["A30000001"] }),
  ];
  const shared = sharedKaptCodes(rows);
  assert.equal(classifyComplex(rows[0], shared), "ALREADY_LOADED");
  assert.equal(classifyComplex(rows[1], shared), "READY");
  assert.equal(classifyComplex(rows[2], shared), "UNMAPPED");
  assert.equal(classifyComplex(rows[3], shared), "AMBIGUOUS");
  assert.equal(classifyComplex(rows[4], shared), "AMBIGUOUS");
  assert.equal(classifyComplex(rows[5], shared), "AMBIGUOUS");

  const summary = aggregateInventory([
    row({ complex_id: "cx_s1", sido_code: "11", sido: "서울", kapt_codes: ["A10000001"], has_fee: true }),
    row({ complex_id: "cx_b1", sido_code: "26", sido: "부산", kapt_codes: ["A20000001"] }),
    row({ complex_id: "cx_b2", sido_code: "26", sido: "부산", kapt_codes: ["A20000002"] }),
    row({ complex_id: "cx_b3", sido_code: "26", sido: "부산" }),
    row({ complex_id: "cx_i1", sido_code: "28", sido: "인천", kapt_codes: ["A30000001"] }),
    row({ complex_id: "cx_d1", sido_code: "27", sido: "대구", kapt_codes: ["A40000001"] }),
  ]);
  assert.equal(summary.national.master, 6);
  assert.equal(summary.national.kapt_mapped, 5);
  assert.equal(summary.national.ready_unloaded, 4);
  assert.equal(summary.national.existing_fee_complexes, 1);
  const wave = selectWaveSidos(summary.by_sido, 2);
  assert.deepEqual(wave.map((item) => item.sido_code), ["26", "27"]);
  assert.equal(selectWaveSidos([summary.by_sido.find((item) => item.sido_code === "11")!], 2).length, 0);

  assert.deepEqual(parseExplicitPeriods("202607,202608"), ["202607", "202608"]);
  assert.deepEqual(parseExplicitPeriods("202607-202609"), ["202607", "202608", "202609"]);
  assert.throws(() => parseExplicitPeriods("202601-202612"), /exceeds 3/);
  assert.deepEqual(buildProbePeriods("202609", 3), ["202609", "202608", "202607"]);
  assert.equal(
    choosePublishedPeriod([
      { period: "202609", published: false },
      { period: "202608", published: true },
      { period: "202607", published: true },
    ]),
    "202608",
  );

  const complexes: WaveComplex[] = Array.from({ length: 30 }, (_, index) => ({
    complex_id: `cx_${String(index).padStart(2, "0")}`,
    sido: "부산",
    sido_code: "26",
    kapt_code: `A2${String(index).padStart(7, "0")}`,
    state: "READY" as const,
  }));
  complexes.push({
    complex_id: "cx_loaded",
    sido: "부산",
    sido_code: "26",
    kapt_code: "A10000001",
    state: "ALREADY_LOADED",
  });
  const picked = planWaveCohort({ complexes, perSido: 25, totalCap: 50 });
  assert.equal(picked.length, 25);
  assert.equal(picked.some((item) => item.state !== "READY"), false);
  assert.equal(chunkItems(picked, 25).length, 1);

  assert.equal(planWriteAction("MISSING", false), "skip");
  assert.equal(planWriteAction("PARTIAL", false), "skip");
  assert.equal(planWriteAction("COMPLETE", false), "insert");
  assert.equal(planWriteAction("COMPLETE", true), "update");

  const target = {
    complex_id: "cx_ready_busan",
    sido: "부산",
    sido_code: "26",
    kapt_code: "A20000001",
    period: "202607",
  };
  let callsMade = 0;
  const first = await runExpansionDryRun({
    targets: [target, { ...target, complex_id: "cx_second", kapt_code: "A20000002" }],
    calls,
    sleep: async () => undefined,
    fetchOp: async (args) => {
      callsMade += 1;
      if (args.complex_id === "cx_second") throw new RateLimitStop("HTTP 429");
      return success(10);
    },
  });
  assert.equal(first.stopped, "HOLD_429");
  assert.equal(first.records[1]?.status, "HOLD_429");
  assert.equal(first.records[0]?.status, "COMPLETE");
  assert.equal(first.records[0]?.would, "insert");
  assert.equal(first.records[0]?.amount, 20);
  assert.equal(callsMade, 3);

  const second = await runExpansionDryRun({
    targets: [target],
    calls,
    store: first.store,
    prior: first.records.filter((record) => record.complex_id === target.complex_id),
    sleep: async () => undefined,
    fetchOp: async () => {
      throw new Error("completed target was refetched");
    },
  });
  assert.equal(second.api_calls, 0);
  assert.equal(second.records[0]?.status, "COMPLETE");

  console.log(JSON.stringify({ ok: true, wave: wave.map((item) => item.sido_code) }));
}

main();
