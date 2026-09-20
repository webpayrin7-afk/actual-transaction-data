import assert from "node:assert/strict";
import { buildingIdFromOfficialKey, areaCents, officialKeyFromTitlePk } from "../src/lib/buildings/identity";
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
  assert.equal(officialKeyFromTitlePk("10251100216862"), "10251100216862");
  assert.equal(officialKeyFromTitlePk("1.0000000000000055e+21"), null);
  assert.equal(officialKeyFromTitlePk(""), null);
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
      heit: 53.4,
      grndFlrCnt: 19,
      ugrndFlrCnt: 2,
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
  assert.equal(row!.heightM, 53.4);
  assert.equal(row!.heightStatus, "OFFICIAL_HEIGHT");
  assert.equal(row!.threeDReadiness, "NO_GEOMETRY");
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

function testHeightAndThreeD() {
  const { heightAttrsFromTitle } = require("../src/lib/buildings/height") as typeof import("../src/lib/buildings/height");
  const { classifyThreeD } = require("../src/lib/buildings/three-d") as typeof import("../src/lib/buildings/three-d");
  const official = heightAttrsFromTitle({ heit: "48.4", grndFlrCnt: "18" });
  assert.equal(official.heightStatus, "OFFICIAL_HEIGHT");
  assert.equal(official.heightM, 48.4);
  const floors = heightAttrsFromTitle({ heit: "0", grndFlrCnt: "15" });
  assert.equal(floors.heightStatus, "FLOOR_COUNT_ONLY");
  assert.equal(floors.heightM, null);
  const missing = heightAttrsFromTitle({ heit: "", grndFlrCnt: "0" });
  assert.equal(missing.heightStatus, "HEIGHT_MISSING");
  assert.equal(classifyThreeD({ hasOfficialFootprint: true, heightStatus: "OFFICIAL_HEIGHT" }), "3D_EXACT");
  assert.equal(classifyThreeD({ hasOfficialFootprint: true, heightStatus: "FLOOR_COUNT_ONLY" }), "3D_PARTIAL");
  assert.equal(classifyThreeD({ hasOfficialFootprint: true, heightStatus: "HEIGHT_MISSING" }), "FOOTPRINT_ONLY");
  assert.equal(classifyThreeD({ hasOfficialFootprint: false, heightStatus: "OFFICIAL_HEIGHT" }), "NO_GEOMETRY");
}

function testHouseholdSemantics() {
  const { deriveHouseholdCounts, uiSafeTypeSum, displayedExceedsPhysical } = require("../src/lib/buildings/counts") as typeof import("../src/lib/buildings/counts");
  const banpo = deriveHouseholdCounts({
    types: [
      { unitTypeId: "ut_a", exclusiveCents: 8494, supplyCents: 11687, status: "AMBIGUOUS_MULTI", householdCount: 724 },
      { unitTypeId: "ut_b", exclusiveCents: 8494, supplyCents: 11688, status: "AMBIGUOUS_MULTI", householdCount: 724 },
      { unitTypeId: "ut_c", exclusiveCents: 5997, supplyCents: 8424, status: "EXACT_SINGLE", householdCount: 158 },
    ],
    units: [],
  });
  assert.equal(banpo.types.find((t) => t.unitTypeId === "ut_a")?.countStatus, "EXCLUSIVE_GROUP_ONLY");
  assert.equal(banpo.types.find((t) => t.unitTypeId === "ut_a")?.householdCount, null);
  assert.equal(banpo.types.find((t) => t.unitTypeId === "ut_c")?.countStatus, "EXACT_SINGLE_VARIANT_COUNT");
  assert.equal(banpo.groups.find((g) => g.exclusiveCents === 8494)?.householdCount, 724);
  assert.equal(uiSafeTypeSum(banpo.types), 158);
  assert.equal(displayedExceedsPhysical(uiSafeTypeSum(banpo.types), 3410), false);

  const fromUnits = deriveHouseholdCounts({
    types: [
      { unitTypeId: "ut_a", exclusiveCents: 8480, supplyCents: 11152, status: "EXACT_SINGLE", householdCount: 3 },
      { unitTypeId: "ut_b", exclusiveCents: 8480, supplyCents: 10929, status: "AMBIGUOUS_MULTI", householdCount: 3 },
    ],
    units: [
      { dong: "101동", floor: "1", ho: "101", exclusiveArea: 84.8, residentialCommonArea: 26.72, officialBuildingKey: "1", sourceAsOf: "2026", sourceKey: "a" },
      { dong: "101동", floor: "2", ho: "201", exclusiveArea: 84.8, residentialCommonArea: 24.49, officialBuildingKey: "1", sourceAsOf: "2026", sourceKey: "b" },
    ],
  });
  assert.equal(fromUnits.types.reduce((n, t) => n + (t.householdCount ?? 0), 0), 2);
}

function testGisJoinIdentity() {
  const { joinGisFeature, pnuUniqueJoinAllowed } = require("../src/lib/buildings/gis-join") as typeof import("../src/lib/buildings/gis-join");
  const buildings = new Map([["10251100216862", { officialBuildingKey: "10251100216862" }]]);
  const matched = joinGisFeature(
    { properties: { BLDRGST_PK: "10251100216862", UFID: "u1", PNU: "1171010100100190000" }, geometry: { type: "Polygon", coordinates: [] } },
    buildings,
    new Map([["1171010100100190000", ["10251100216862"]]]),
    new Map([["1171010100100190000", 72]]),
  );
  assert.equal(matched.status, "MATCHED");
  assert.equal(matched.evidence, "official_building_register_pk");
  const unresolved = joinGisFeature(
    { properties: { UFID: "u1", PNU: "1171010100100190000", DONG_NM: "101동" }, geometry: { type: "Polygon", coordinates: [] } },
    buildings,
    new Map([["1171010100100190000", ["10251100216862", "pk2"]]]),
    new Map([["1171010100100190000", 72]]),
  );
  assert.equal(unresolved.status, "GEOMETRY_IDENTITY_UNRESOLVED");
  assert.equal(pnuUniqueJoinAllowed(1, 1), true);
  assert.equal(pnuUniqueJoinAllowed(72, 72), false);
}

function testPkTypeLinks() {
  const links = buildTypeBuildingLinks({
    source: "test",
    types: [
      { unitTypeId: "ut_a", exclusiveCents: 8480, supplyCents: 11152, status: "EXACT_SINGLE", householdCount: 3 },
    ],
    buildings: [
      { buildingId: "bd_1", dongLabel: "101동", residentialFlag: true, officialBuildingKey: "pk1" },
      { buildingId: "bd_2", dongLabel: "102동", residentialFlag: true, officialBuildingKey: "pk2" },
    ],
    units: [
      { dong: "x", floor: "1", ho: "101", exclusiveArea: 84.8, residentialCommonArea: 26.72, officialBuildingKey: "pk1", sourceAsOf: "2026", sourceKey: "a" },
      { dong: "y", floor: "2", ho: "201", exclusiveArea: 84.8, residentialCommonArea: 26.72, officialBuildingKey: "pk2", sourceAsOf: "2026", sourceKey: "b" },
    ],
  });
  assert.equal(links.links.length, 2);
}

function testParcelCadastral() {
  const { parcelFromCadastralPnu, hubPnu } = require("../src/lib/buildings/parcel") as typeof import("../src/lib/buildings/parcel");
  const p = parcelFromCadastralPnu("1171010100100190000");
  assert.ok(p);
  assert.equal(p!.platGbCd, "0");
  assert.equal(hubPnu(p!), "1171010100000190000");
}

testIdentity();
testResidential();
testDong();
testParcel();
testTitleMap();
testTypeLinks();
testParity();
testHeightAndThreeD();
testHouseholdSemantics();
testGisJoinIdentity();
testPkTypeLinks();
testParcelCadastral();
console.log("test-building-topology ok");
