#!/usr/bin/env npx tsx
/**
 * Unit tests for PROFILE national background closeout helpers.
 */
import assert from "node:assert/strict";
import {
  compareValues,
  coreChipCount,
  decideFills,
  heroBucket,
  isValidField,
  normalizeDate,
  regionOf,
  resolveAgreedCandidate,
  valuesMateriallyDiffer,
  type Candidate,
} from "./profile-national-lib";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

test("region priority gyeonggi before seoul", () => {
  assert.equal(regionOf("41135").key, "GYEONGGI");
  assert.equal(regionOf("41135").priority, 0);
  assert.equal(regionOf("11680").key, "SEOUL");
  assert.equal(regionOf("11680").priority, 1);
  assert.equal(regionOf("28110").key, "INCHEON");
  assert.equal(regionOf("12000").key, "GWANGJU_JEONNAM");
  assert.ok(regionOf("12000").priority > regionOf("26110").priority);
});

test("classification buckets", () => {
  assert.equal(heroBucket(null), "NO_PROFILE");
  assert.equal(
    heroBucket({
      household_count: 100,
      building_count: 2,
      approval_date: "2008-01-01",
      max_floor: 20,
      parking_per_household: 1,
      far_ratio: 200,
      bcr_ratio: 20,
      heating_type: "지역난방",
    }),
    "FULL_HERO",
  );
  assert.equal(
    heroBucket({
      household_count: 100,
      building_count: 2,
      approval_date: "2008-01-01",
      max_floor: 20,
      parking_per_household: 1,
      far_ratio: 200,
      bcr_ratio: null,
      heating_type: null,
    }),
    "GOOD_HERO",
  );
  assert.equal(heroBucket({ household_count: 1 }), "PARTIAL_HERO");
});

test("core chips", () => {
  assert.equal(coreChipCount(null), 0);
  assert.equal(coreChipCount({ household_count: 1 }), 1);
  assert.equal(
    coreChipCount({
      household_count: 1,
      building_count: 2,
      approval_date: "2008-01-01",
    }),
    3,
  );
});

test("field validation", () => {
  assert.equal(isValidField("household_count", 0), false);
  assert.equal(isValidField("household_count", 10), true);
  assert.equal(isValidField("far_ratio", 0), false);
  assert.equal(isValidField("far_ratio", 275.99), true);
  assert.equal(isValidField("bcr_ratio", 101), false);
  assert.equal(isValidField("heating_type", "없음"), false);
  assert.equal(isValidField("heating_type", "지역난방"), true);
  assert.equal(isValidField("approval_date", "20080930"), true);
  assert.equal(normalizeDate("20080930"), "2008-09-30");
});

test("material conflict parking jamsil pattern", () => {
  assert.equal(valuesMateriallyDiffer("parking_total", 7455, 7712), true);
  assert.equal(compareValues("parking_total", 100, 100), "EXACT_SAME");
});

test("identity: agree vs conflict", () => {
  const a: Candidate = {
    value: 100,
    source: "KAPT_BASIC_V5",
    source_key: "A1",
    raw: 100,
  };
  const b: Candidate = {
    value: 100,
    source: "BUILDING_HUB_RECAP",
    source_key: "P1",
    raw: 100,
  };
  const c: Candidate = {
    value: 200,
    source: "BUILDING_HUB_RECAP",
    source_key: "P1",
    raw: 200,
  };
  assert.equal(resolveAgreedCandidate("household_count", [a, b]).ambiguous, false);
  assert.equal(resolveAgreedCandidate("household_count", [a, c]).ambiguous, true);
});

test("null safe fill decision preserves existing", () => {
  const existing = {
    complex_id: "cx_x",
    household_count: 5678,
    building_count: 72,
    approval_date: "2008-09-30",
    heating_type: "지역난방",
    parking_total: null as number | null,
    parking_per_household: null as number | null,
    far_ratio: 275.99,
    bcr_ratio: 16.41,
    max_floor: 34,
    source: "COMPOSITE",
    source_version: "v",
    raw_meta_json: null,
  };
  const bags = {
    household_count: [
      {
        value: 9999,
        source: "KAPT_BASIC_V5",
        source_key: "A",
        raw: 9999,
      } satisfies Candidate,
    ],
    parking_total: [
      {
        value: 7455,
        source: "KAPT_DETAIL_V5",
        source_key: "A",
        raw: 7455,
      } satisfies Candidate,
      {
        value: 7712,
        source: "BUILDING_HUB_RECAP",
        source_key: "P",
        raw: 7712,
      } satisfies Candidate,
    ],
  };
  const d = decideFills(existing, bags);
  assert.equal(d.fills.household_count, undefined);
  assert.ok(d.conflicts >= 1);
  assert.equal(d.fills.parking_total, undefined);
  assert.equal(d.ambiguous >= 1 || d.conflicts >= 1, true);
});

test("semantic: building inventory count not auto-mapped", () => {
  // decideFills only sees bags we pass; inventory count is never injected by collectCandidates
  const d = decideFills(null, {
    max_floor: [
      {
        value: 20,
        source: "COMPLEX_BUILDINGS_MAX_FLOOR",
        source_key: "residential_main_exact",
        raw: 20,
      },
    ],
  });
  assert.equal(d.fills.max_floor?.value, 20);
  assert.equal(d.fills.building_count, undefined);
  assert.equal(d.fills.household_count, undefined);
});

console.log("ALL_TESTS_PASSED");
