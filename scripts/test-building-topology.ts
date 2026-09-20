import assert from "node:assert/strict";
import { buildingIdFromOfficialKey, areaCents } from "../src/lib/buildings/identity";
import { isResidentialBuilding, isMainBuilding } from "../src/lib/buildings/residential";
import { officialDongLabel, dongMatchKey } from "../src/lib/buildings/dong-label";
import { parcelFromParts, hubPnu, cadastralPnu } from "../src/lib/buildings/parcel";
import { buildingFromTitleRow } from "../src/lib/buildings/from-title";
import { resolveUnitTypeId, buildTypeBuildingLinks } from "../src/lib/buildings/type-links";
import { classifyParity } from "../src/lib/buildings/parity";

function testIdentity() {
  const a = buildingIdFromOfficialKey("10251100216862");
  const b = buildingIdFromOfficialKey("10251100216862");
  assert.equal(a, b);
  assert.match(a, /^bd_[0-9a-f]{16}$/);
  assert.notEqual(a, buildingIdFromOfficialKey("http://example.com/10251100216862"));
  assert.equal(areaCents(84.8), 8480);
  assert.equal(areaCents(84.88), 8488);
  assert.equal(areaCents(84.97), 8497);
}

function testResidential() {
  const apt = {
    mainAtchGbCd: "0",
    mainAtchGbCdNm: "주건축물",
    mainPurpsCd: "02000",
    mainPurpsCdNm: "공동주택",
    hhldCnt: 36,
  };
  assert.equal(isMainBuilding(apt), true);
  assert.equal(isResidentialBuilding(apt), true);

  const shop = {
    mainAtchGbCd: "0",
    mainAtchGbCdNm: "주건축물",
    mainPurpsCd: "03000",
    mainPurpsCdNm: "제1종근린생활시설",
    etcPurps: "상가",
    hhldCnt: 0,
    bldNm: "101동",
  };
  assert.equal(isResidentialBuilding(shop), false);

  const mgmt = {
    mainAtchGbCd: "0",
    mainAtchGbCdNm: "주건축물",
    mainPurpsCd: "04000",
    mainPurpsCdNm: "업무시설",
    bldNm: "관리동",
    hhldCnt: 0,
  };
  assert.equal(isResidentialBuilding(mgmt), false);

  const annex = {
    mainAtchGbCd: "1",
    mainAtchGbCdNm: "부속건축물",
    mainPurpsCd: "02000",
    mainPurpsCdNm: "공동주택",
    hhldCnt: 10,
    bldNm: "102동",
  };
  assert.equal(isResidentialBuilding(annex), false);
}

function testDong() {
  assert.deepEqual(officialDongLabel("101동"), {
    dongLabel: "101동",
    status: "EXACT_DONG_LABEL",
  });
  assert.deepEqual(officialDongLabel("  "), {
    dongLabel: null,
    status: "MISSING_DONG_LABEL",
  });
  assert.equal(dongMatchKey("101동"), "101");
  assert.equal(dongMatchKey("101"), "101");
  assert.equal(dongMatchKey(null), null);
}

function testParcel() {
  const p = parcelFromParts("11710", "10100", "19");
  assert.ok(p);
  assert.equal(hubPnu(p!), "1171010100000190000");
  assert.equal(cadastralPnu(p!), "1171010100100190000");
  const p2 = parcelFromParts("11650", "10700", "18-1");
  assert.equal(p2?.bun, "0018");
  assert.equal(p2?.ji, "0001");
}

function testTitleMap() {
  const row = buildingFromTitleRow(
    {
      mgmBldrgstPk: 10251100216862,
      bldNm: "잠실엘스",
      dongNm: "169동",
      mainAtchGbCd: "0",
      mainAtchGbCdNm: "주건축물",
      mainPurpsCd: "02000",
      mainPurpsCdNm: "공동주택",
      hhldCnt: 36,
      grndFlrCnt: 19,
      crtnDay: "20220813",
    },
    "cx_4c63d9a100973c60",
    "20220813",
  );
  assert.ok(row);
  assert.equal(row!.residentialFlag, true);
  assert.equal(row!.dongLabel, "169동");
  assert.equal(row!.status, "EXACT");
  assert.equal(row!.officialBuildingKey, "10251100216862");
}

function testTypeLinks() {
  const exact = resolveUnitTypeId(84.8, 26.72, [
    { unitTypeId: "ut_a", exclusiveCents: 8480, supplyCents: 11152, status: "EXACT_SINGLE", householdCount: 2938 },
  ]);
  assert.equal(exact.unitTypeId, "ut_a");
  assert.equal(exact.status, "EXACT");

  const amb = resolveUnitTypeId(84.8, null, [
    { unitTypeId: "ut_b", exclusiveCents: 8480, supplyCents: 11152, status: "AMBIGUOUS_MULTI", householdCount: 10 },
    { unitTypeId: "ut_c", exclusiveCents: 8480, supplyCents: 10929, status: "AMBIGUOUS_MULTI", householdCount: 10 },
  ]);
  assert.equal(amb.unitTypeId, null);
  assert.equal(amb.status, "TYPE_VARIANT_AMBIGUOUS");

  const ambResolved = resolveUnitTypeId(84.8, 26.72, [
    { unitTypeId: "ut_b", exclusiveCents: 8480, supplyCents: 11152, status: "AMBIGUOUS_MULTI", householdCount: 10 },
    { unitTypeId: "ut_c", exclusiveCents: 8480, supplyCents: 10929, status: "AMBIGUOUS_MULTI", householdCount: 10 },
  ]);
  assert.equal(ambResolved.unitTypeId, "ut_b");

  const links = buildTypeBuildingLinks({
    source: "test",
    types: [
      { unitTypeId: "ut_a", exclusiveCents: 8480, supplyCents: 11152, status: "EXACT_SINGLE", householdCount: 3 },
    ],
    buildings: [
      { buildingId: "bd_1", dongLabel: "101동", residentialFlag: true },
      { buildingId: "bd_2", dongLabel: "102동", residentialFlag: true },
    ],
    units: [
      { dong: "101동", floor: "1", ho: "101", exclusiveArea: 84.8, residentialCommonArea: 26.72, sourceAsOf: "2026", sourceKey: "a" },
      { dong: "101동", floor: "1", ho: "101", exclusiveArea: 84.8, residentialCommonArea: 26.72, sourceAsOf: "2026", sourceKey: "dup" },
      { dong: "102동", floor: "2", ho: "201", exclusiveArea: 84.8, residentialCommonArea: 26.72, sourceAsOf: "2026", sourceKey: "b" },
    ],
  });
  assert.equal(links.links.length, 2);
  assert.equal(links.links.find((l) => l.buildingId === "bd_1")?.householdCount, 1);
}

function testParity() {
  assert.equal(
    classifyParity({
      kaptHousehold: 5678,
      unitHousehold: 5678,
      typeHouseholdSum: 5678,
      buildingHouseholdSum: 5678,
    }).parityClass,
    "PARITY",
  );
  assert.equal(
    classifyParity({
      kaptHousehold: 5678,
      unitHousehold: 5670,
      typeHouseholdSum: 5678,
      buildingHouseholdSum: 5678,
    }).parityClass,
    "MINOR_SCOPE_DIFF",
  );
  assert.equal(
    classifyParity({
      kaptHousehold: 5678,
      unitHousehold: 2000,
      typeHouseholdSum: 2000,
      buildingHouseholdSum: 2000,
    }).parityClass,
    "MAJOR_MISMATCH",
  );
}

testIdentity();
testResidential();
testDong();
testParcel();
testTitleMap();
testTypeLinks();
testParity();
console.log("test-building-topology ok");
