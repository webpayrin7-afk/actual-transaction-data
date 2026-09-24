import assert from "node:assert/strict";
import { jibunToken, masterJibun, normalizeAddress } from "./kapt-match";
import { cadastralToRegistryPnu, hallOrNull, hubFromRows, kaptParking, parkingPerHousehold, pickAgreed } from "./rules";

assert.equal(cadastralToRegistryPnu("1171010100100190000"), "1171010100000190000");
assert.equal(hallOrNull("계단식"), "계단식");
assert.equal(hallOrNull("타워형"), null);
assert.equal(parkingPerHousehold(6075, 3410), 1.7815);
assert.deepEqual(pickAgreed(5678, 5678), { value: 5678, conflict: false });
assert.deepEqual(pickAgreed(7712, 7455), { value: null, conflict: true });
assert.equal(kaptParking({ kaptdPcnt: "10", kaptdPcntu: "7445" }), 7455);
assert.equal(kaptParking({ kaptdPcnt: "10" }), null);

const recap = hubFromRows([{ vlRat: 275.99, bcRat: 16.41, hhldCnt: 5678, totPkngCnt: 7712 }], []);
assert.equal(recap?.rule, "RECAP");
assert.equal(recap?.household, 5678);

const summed = hubFromRows([], [
  { mainAtchGbCdNm: "주건축물", mainPurpsCdNm: "아파트", vlRat: 200, bcRat: 20, hhldCnt: 10, totPkngCnt: 8 },
  { mainAtchGbCdNm: "주건축물", mainPurpsCdNm: "아파트", vlRat: 200, bcRat: 18, hhldCnt: 12, totPkngCnt: 9 },
  { mainAtchGbCdNm: "부속건축물", mainPurpsCdNm: "근린생활시설", hhldCnt: 99, totPkngCnt: 99 },
]);
assert.equal(summed?.rule, "TITLE_SUM_MAIN_APT");
assert.equal(summed?.household, 22);
assert.equal(summed?.parking, 17);
assert.equal(summed?.far, 200);
assert.equal(summed?.bcr, null);

assert.deepEqual(jibunToken("경기도 파주시 금촌동 792-3 보광그랑베르"), { san: false, bun: "0792", ji: "0003" });
assert.equal(jibunToken("서울특별시 송파구 잠실동 19 잠실엘스아파트")?.bun, "0019");
assert.equal(jibunToken("서울 강남구 역삼동 1 2"), null);
assert.deepEqual(masterJibun("1-102"), { san: false, bun: "0001", ji: "0102" });
assert.equal(normalizeAddress("  경기도  파주시 중앙로 215 "), "경기도 파주시 중앙로 215");
console.log("test-profile-rules: ok");
