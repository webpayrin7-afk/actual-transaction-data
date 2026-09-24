/**
 * Fixture tests for the live parser and sample guards.
 * Does not call the fee API.
 */
import assert from "node:assert/strict";
import { buildLiveCalls } from "./mgmt-fee-canonical/live-calls";
import {
  MappingStop,
  RateLimitStop,
  SchemaStop,
  parseFeeResponse,
  sumExplicitAmounts,
} from "./mgmt-fee-canonical/live-parse";
import { OpCheckpointStore } from "./mgmt-fee-canonical/op-checkpoint";
import { assertReadOnlySql, assertSampleScope, REAL_SAMPLE_TARGETS } from "./mgmt-fee-canonical/real-sample";

function main(): void {
  assertSampleScope(REAL_SAMPLE_TARGETS);
  assert.ok(REAL_SAMPLE_TARGETS.length <= 15);
  assert.ok(new Set(REAL_SAMPLE_TARGETS.map((target) => target.complex_id)).size <= 5);
  assert.throws(() => assertSampleScope([
    ...Array.from({ length: 16 }, (_, index) => ({
      complex_id: `cx_extra_${index}`,
      kapt_code: "A10000000",
      region: "seoul" as const,
      period_yyyymm: "202607",
    })),
  ]), /target-month cap/);

  const summed = sumExplicitAmounts({
    kaptCode: "A13822004",
    kaptName: "잠실엘스아파트",
    cleanCost: 10,
    emptyNote: "",
  });
  assert.equal(summed.amount, 10);
  assert.deepEqual(summed.numeric_fields, ["cleanCost"]);

  const zeros = sumExplicitAmounts({ measured: 0, other: 0 });
  assert.equal(zeros.amount, 0);
  assert.deepEqual(zeros.explicit_zero_fields, ["measured", "other"]);

  const parsed = parseFeeResponse({
    http: 200,
    expectedKapt: "A13822004",
    body: JSON.stringify({
      response: {
        header: { resultCode: "00", resultMsg: "NORMAL SERVICE." },
        body: { item: { kaptCode: "A13822004", kaptName: "잠실엘스아파트", cleanCost: 134274250 } },
      },
    }),
  });
  assert.equal(parsed.state, "success");
  assert.equal(parsed.amount, 134274250);

  const empty = parseFeeResponse({
    http: 200,
    expectedKapt: "A13822004",
    body: JSON.stringify({
      response: { header: { resultCode: "03", resultMsg: "NODATA" }, body: {} },
    }),
  });
  assert.equal(empty.state, "missing");
  assert.equal(empty.amount, null);

  const explicit = parseFeeResponse({
    http: 200,
    expectedKapt: "A13822004",
    body: JSON.stringify({
      response: {
        header: { resultCode: "00", resultMsg: "OK" },
        body: { item: { kaptCode: "A13822004", cleanCost: 0 } },
      },
    }),
  });
  assert.equal(explicit.state, "success");
  assert.equal(explicit.amount, 0);

  assert.throws(
    () => parseFeeResponse({ http: 429, expectedKapt: "A13822004", body: "slow down" }),
    RateLimitStop,
  );
  const amountWith429 = parseFeeResponse({
    http: 200,
    expectedKapt: "A13822004",
    body: JSON.stringify({
      response: {
        header: { resultCode: "00", resultMsg: "NORMAL SERVICE." },
        body: { item: { kaptCode: "A13822004", cleanCost: 1429000 } },
      },
    }),
  });
  assert.equal(amountWith429.state, "success");
  assert.equal(amountWith429.amount, 1429000);
  assert.throws(
    () => parseFeeResponse({ http: 200, expectedKapt: "A13822004", body: "<html>nope</html>" }),
    SchemaStop,
  );
  assert.throws(
    () =>
      parseFeeResponse({
        http: 200,
        expectedKapt: "A13822004",
        body: JSON.stringify({
          response: {
            header: { resultCode: "00", resultMsg: "OK" },
            body: { item: { kaptCode: "A00000000", cleanCost: 1 } },
          },
        }),
      }),
    MappingStop,
  );

  const store = OpCheckpointStore.empty();
  assert.equal(store.shouldFetch("cx_dryrun_seoul_1", "202607", "common", "op_a"), true);
  store.put({
    complex_id: "cx_dryrun_seoul_1",
    period: "202607",
    op: "op_a",
    service: "common",
    status: "success",
    http: 200,
    result_class: "ok_00",
    amount: 1,
    numeric_fields: ["cleanCost"],
    explicit_zero_fields: [],
    error: null,
    completed_at: "2026-09-18T00:00:00.000Z",
  });
  assert.equal(store.shouldFetch("cx_dryrun_seoul_1", "202607", "common", "op_a"), false);
  store.put({
    complex_id: "cx_dryrun_seoul_1",
    period: "202607",
    op: "op_b",
    service: "common",
    status: "failed",
    http: 500,
    result_class: "result_99",
    amount: null,
    numeric_fields: [],
    explicit_zero_fields: [],
    error: "timeout",
    completed_at: "2026-09-18T00:00:00.000Z",
  });
  assert.equal(store.shouldFetch("cx_dryrun_seoul_1", "202607", "common", "op_b"), true);
  store.put({
    complex_id: "cx_dryrun_seoul_1",
    period: "202607",
    op: "op_c",
    service: "common",
    status: "failed",
    http: 400,
    result_class: "openapi_12",
    amount: null,
    numeric_fields: [],
    explicit_zero_fields: [],
    error: "retired",
    completed_at: "2026-09-18T00:00:00.000Z",
  });
  assert.equal(store.shouldFetch("cx_dryrun_seoul_1", "202607", "common", "op_c"), false);

  assert.doesNotThrow(() =>
    assertReadOnlySql(
      "SELECT complex_id, total_fee FROM apt_complex_mgmt_fee_monthly WHERE complex_id = ?",
    ),
  );
  assert.throws(() => assertReadOnlySql("UPDATE apt_complex_mgmt_fee_monthly SET total_fee = 1"), /write forbidden/);
  assert.throws(() => assertReadOnlySql("DELETE FROM apt_complex_mgmt_fee_monthly"), /write forbidden/);

  const calls = buildLiveCalls();
  assert.ok(calls.length > 0);
  assert.ok(calls.some((call) => call.in_main && !call.in_reference));
  assert.ok(calls.some((call) => call.in_reference && !call.in_main));

  const source = REAL_SAMPLE_TARGETS.map((target) => target.kapt_code).join(",");
  assert.equal(source.includes("serviceKey"), false);

  console.log(JSON.stringify({ ok: true, live_calls: calls.length, targets: REAL_SAMPLE_TARGETS.length }));
}

main();
