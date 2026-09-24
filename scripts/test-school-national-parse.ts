/**
 * Offline checks for the verified SchoolInfo mappings.
 * 잠실중 / 잠신중 2025 apiType52 totals are the pilot anchors.
 */
import assert from "node:assert/strict";
import {
  graduateCategoryStatus,
  parseHighGraduate,
  parseMiddleGraduate,
  parseScholarship,
  scholarshipCategoryStatus,
} from "../src/lib/school-national/parse";
import { masterWriteAction, rollupSchool, snapshotWriteAction } from "../src/lib/school-national/policy";

const JAMSIL_MIDDLE = {
  SCHUL_CODE: "S010000888",
  SCHUL_NM: "잠실중학교",
  TOTAL2: 337,
  TOTAL3: 223,
  TOTAL4: 6,
  TOTAL5: 4,
  TOTAL6: 9,
  TOTAL7: 3,
  TOTAL8: 1,
  TOTAL9: 86,
  TOTAL10: 0,
  TOTAL11: 5,
  TOTAL12: 0,
  TOTAL13: 0,
  TOTAL14: 0,
};

const JAMSIN_MIDDLE = {
  SCHUL_CODE: "S010000887",
  SCHUL_NM: "잠신중학교",
  TOTAL2: 327,
  TOTAL3: 236,
  TOTAL4: 8,
  TOTAL5: 1,
  TOTAL6: 6,
  TOTAL7: 6,
  TOTAL8: 1,
  TOTAL9: 61,
  TOTAL10: 0,
  TOTAL11: 7,
  TOTAL12: 0,
  TOTAL13: 1,
  TOTAL14: 0,
};

const JAMSIL_HIGH = {
  SCHUL_CODE: "S010000523",
  SCHUL_NM: "잠실고등학교",
  TOTAL2: 176,
  TOTAL3: 27,
  TOTAL4: 80,
  TOTAL5: 0,
  TOTAL6: 0,
  TOTAL7: 1,
  TOTAL8: 68,
};

function expectMiddle(row: Record<string, unknown>, expected: Record<string, number>) {
  const parsed = parseMiddleGraduate(row);
  assert.ok(parsed);
  assert.equal(parsed.graduates?.raw, expected.TOTAL2);
  assert.equal(parsed.completeness, "full_structurally_confirmed");
  assert.equal(graduateCategoryStatus("middle", parsed), "COMPLETE");
  const byField = new Map(parsed.categories.map((c) => [c.sourceField, c]));
  let sum = 0;
  for (let i = 3; i <= 14; i++) {
    const field = `TOTAL${i}`;
    const cat = byField.get(field);
    assert.ok(cat, field);
    assert.equal(cat.count, expected[field]);
    assert.notEqual(cat.count, null);
    sum += cat.count!;
  }
  assert.equal(sum, expected.TOTAL2);
  assert.equal(byField.get("TOTAL3")?.label, "일반고");
  assert.equal(byField.get("TOTAL9")?.label, "자율형사립고");
  assert.equal(byField.get("TOTAL10")?.label, "자율형공립고");
  assert.equal(byField.get("TOTAL14")?.label, "무직자 및 미상");
}

expectMiddle(JAMSIL_MIDDLE, JAMSIL_MIDDLE);
expectMiddle(JAMSIN_MIDDLE, JAMSIN_MIDDLE);

const high = parseHighGraduate(JAMSIL_HIGH);
assert.ok(high);
assert.equal(high.graduates?.raw, 176);
assert.equal(high.completeness, "full_structurally_confirmed");
const highByKey = new Map(high.categories.map((c) => [c.key, c]));
assert.equal(highByKey.get("junior_college")?.label, "전문대학");
assert.equal(highByKey.get("junior_college")?.count, 27);
assert.equal(highByKey.get("university")?.count, 80);
assert.equal(highByKey.get("overseas")?.label, "국외진학");
assert.equal(highByKey.get("overseas")?.count, 0);
assert.equal(highByKey.get("employed")?.count, 1);
assert.equal(highByKey.get("other")?.count, 68);
assert.equal(
  [...highByKey.values()].reduce((s, c) => s + (c.count ?? 0), 0),
  176,
);

const missingLeaf = parseHighGraduate({ ...JAMSIL_HIGH, TOTAL5: null });
assert.equal(missingLeaf?.categories.find((c) => c.key === "overseas"), undefined);
assert.equal(missingLeaf?.completeness, "partial");
assert.equal(graduateCategoryStatus("high", missingLeaf), "PARTIAL");
assert.equal(graduateCategoryStatus("elementary", null), "NOT_APPLICABLE");

const scholarshipMissing = parseScholarship({ SCHUL_CODE: "S010000888" }, 100);
assert.equal(scholarshipMissing?.total, null);
assert.equal(scholarshipCategoryStatus(scholarshipMissing, "applies"), "NO_DATA");
assert.equal(scholarshipCategoryStatus(null, "not_applicable"), "NOT_APPLICABLE");
const scholarshipZero = parseScholarship({ SCHO_AMT: 0 }, 100);
assert.equal(scholarshipZero?.total?.raw, 0);
assert.equal(scholarshipCategoryStatus(scholarshipZero, "applies"), "COMPLETE");

assert.equal(masterWriteAction(null, { sourceAsOf: "2026", fingerprint: "a" }), "insert");
assert.equal(
  masterWriteAction(
    { sourceAsOf: "2026", fingerprint: "a" },
    { sourceAsOf: "2026", fingerprint: "a" },
  ),
  "skip",
);
assert.equal(
  masterWriteAction(
    { sourceAsOf: "2026", fingerprint: "a" },
    { sourceAsOf: "2026", fingerprint: "b" },
  ),
  "conflict_hold",
);
assert.equal(
  masterWriteAction(
    { sourceAsOf: "2025", fingerprint: "a" },
    { sourceAsOf: "2026", fingerprint: "b" },
  ),
  "update_newer",
);
assert.equal(
  masterWriteAction(
    { sourceAsOf: "2026", fingerprint: "a" },
    { sourceAsOf: "2025", fingerprint: "b" },
  ),
  "skip",
);
assert.equal(snapshotWriteAction(true), "skip");
assert.equal(snapshotWriteAction(false), "insert");

assert.equal(rollupSchool(["COMPLETE", "NOT_APPLICABLE", "COMPLETE"]), "COMPLETE");
assert.equal(rollupSchool(["COMPLETE", "FAILED"]), "PARTIAL");
assert.equal(rollupSchool(["NO_DATA", "NO_DATA"]), "NO_DATA");
assert.equal(rollupSchool(["FAILED", "FAILED"]), "FAILED");

console.log("school-national parse tests: PASS");
