import assert from "node:assert/strict";
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

console.log("test-profile-rules: ok");
