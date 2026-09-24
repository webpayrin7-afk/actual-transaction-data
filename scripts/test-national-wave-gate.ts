import assert from "node:assert/strict";
import {
  evaluateMasterGate,
  productionApplyAllowed,
  selectFirstWave,
  type SidoWaveInput,
} from "../src/lib/national-expansion/wave-gate";

const blocked: SidoWaveInput = {
  sido_code: "26",
  candidate_safe: 0,
  legal_dong_resolver: false,
  sync_lawds: 1,
  cadastral_source: false,
  pnu_source: false,
};

const ready = (sido_code: string, candidate_safe: number): SidoWaveInput => ({
  sido_code,
  candidate_safe,
  legal_dong_resolver: true,
  sync_lawds: 5,
  cadastral_source: true,
  pnu_source: true,
});

assert.deepEqual(selectFirstWave([blocked, ready("11", 8000), ready("41", 6000)]), []);
assert.deepEqual(
  selectFirstWave([ready("26", 10), ready("28", 30), ready("27", 20), ready("31", 5)]),
  ["28", "27", "26"],
);
assert.deepEqual(selectFirstWave([ready("26", 10)]), []);
const noPnu = (sido_code: string, candidate_safe: number): SidoWaveInput => ({
  ...ready(sido_code, candidate_safe),
  pnu_source: false,
  cadastral_source: false,
});
assert.deepEqual(selectFirstWave([noPnu("26", 8), noPnu("27", 9)]), ["27", "26"]);

const fail = evaluateMasterGate({
  selected_sido: [],
  safe: 0,
  ambiguous_in_payload: 0,
  unresolved_in_payload: 0,
  duplicate_complex_id: 0,
  duplicate_external_identity: 0,
  invalid_sido_lawd: 0,
  existing_row_overwrite: 0,
  provenance_missing: 0,
  expected_candidate_count: 0,
});
assert.equal(fail.pass, false);
assert.ok(fail.reasons.includes("safe_count"));
assert.ok(fail.reasons.includes("wave_size"));
assert.equal(productionApplyAllowed(fail.pass), false);
assert.equal(productionApplyAllowed(true), false);

const pass = evaluateMasterGate({
  selected_sido: ["26", "27"],
  safe: 4,
  ambiguous_in_payload: 0,
  unresolved_in_payload: 0,
  duplicate_complex_id: 0,
  duplicate_external_identity: 0,
  invalid_sido_lawd: 0,
  existing_row_overwrite: 0,
  provenance_missing: 0,
  expected_candidate_count: 4,
});
assert.equal(pass.pass, true);
assert.equal(productionApplyAllowed(pass.pass), false);

console.log(JSON.stringify({ ok: true, fail_reasons: fail.reasons }));
