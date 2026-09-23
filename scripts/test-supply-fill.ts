/**
 * Unit checks for the missing-supply fill helpers (no network, no DB).
 * Run: ./node_modules/.bin/tsx scripts/test-supply-fill.ts
 */
import assert from "node:assert/strict";
import { deriveOfficialSupplies, type ExposRow } from "../src/lib/unit-type/official-expos";
import { acceptVworld, cadastralToRegistryPnu, parcelFromRegistryPnu } from "./supply-fill/official-sources";


// 연속지적도 대지=1 → 건축HUB 0, 산=2 → 1.
assert.equal(cadastralToRegistryPnu("4159710500105380000"), "4159710500005380000");
assert.equal(cadastralToRegistryPnu("4159710500205380000"), "4159710500105380000");
assert.equal(cadastralToRegistryPnu("4159710500005380000"), "");
assert.deepEqual(parcelFromRegistryPnu("4159710500005380000"), {
  sigunguCd: "41597",
  bjdongCd: "10500",
  platGbCd: "0",
  bun: "0538",
  ji: "0000",
});

const ok = acceptVworld(
  { lawdCd: "41597", dong: "청계동", jibun: "538" },
  { status: "OK", pnu: "4159710500105380000", level4L: "청계동", text: "경기도 화성시 동탄구 청계동 538" },
);
assert.deepEqual(ok, { ok: true, reason: "OK", registryPnu: "4159710500005380000" });
// 읍면 리: level4L is the 읍, the 리 must appear in the refined text.
assert.equal(
  acceptVworld(
    { lawdCd: "41593", dong: "봉담읍 와우리", jibun: "597" },
    { status: "OK", pnu: "4159325025105970000", level4L: "봉담읍", text: "경기도 화성시 효행구 봉담읍 와우리 597" },
  ).ok,
  true,
);
assert.equal(
  acceptVworld(
    { lawdCd: "41597", dong: "청계동", jibun: "538-1" },
    { status: "OK", pnu: "4159710500105380000", level4L: "청계동", text: "경기도 화성시 동탄구 청계동 538" },
  ).reason,
  "VWORLD_PARCEL_MISMATCH",
);
assert.equal(
  acceptVworld(
    { lawdCd: "41590", dong: "청계동", jibun: "538" },
    { status: "OK", pnu: "4159710500105380000", level4L: "청계동", text: "경기도 화성시 동탄구 청계동 538" },
  ).reason,
  "VWORLD_SIGUNGU_MISMATCH",
);
assert.equal(
  acceptVworld(
    { lawdCd: "41597", dong: "영천동", jibun: "538" },
    { status: "OK", pnu: "4159710500105380000", level4L: "청계동", text: "경기도 화성시 동탄구 청계동 538" },
  ).reason,
  "VWORLD_DONG_MISMATCH",
);

// "202동 2101" in hoNm with blank dongNm is one unit (dong 202동, ho 2101).
function unit(ho: string, ex: number, stair: number, dong = " "): ExposRow[] {
  return [
    { dongNm: dong, hoNm: ho, exposPubuseGbCdNm: "전유", mainAtchGbCdNm: "주건축물", mainPurpsCdNm: "아파트", area: ex, bldNm: "테스트" },
    { dongNm: dong, hoNm: ho, exposPubuseGbCdNm: "공용", mainAtchGbCdNm: "주건축물", mainPurpsCdNm: "아파트", etcPurps: "계단실", area: stair, bldNm: "테스트" },
  ];
}
const rows = [...unit("202동 2101", 84.97, 25.3), ...unit("202동 2102", 84.97, 25.3), ...unit("202동 2103", 84.97, 25.3)];
const derived = deriveOfficialSupplies(rows, "테스트아파트");
assert.equal(derived.units.length, 3);
assert.equal(derived.units[0]!.dong, "202동");
assert.equal(derived.supplies.length, 1);
assert.equal(derived.supplies[0]!.supplyCents, 11027);
assert.equal(derived.distinguishable, true);

// 발코니 as main-building common is not residential common → unit not derivable (held, not guessed).
const balcony = [
  ...unit("101-101", 59.9, 20),
  { dongNm: "", hoNm: "101-101", exposPubuseGbCdNm: "공용", mainAtchGbCdNm: "주건축물", mainPurpsCdNm: "부대시설", etcPurps: "발코니", area: 5, bldNm: "테스트" },
];
assert.equal(deriveOfficialSupplies(balcony, "테스트").units[0]!.derivable, false);

console.log("test-supply-fill: ok");
